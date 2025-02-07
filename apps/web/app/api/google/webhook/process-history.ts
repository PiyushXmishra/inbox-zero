import uniqBy from "lodash/uniqBy";
import { NextResponse } from "next/server";
import type { gmail_v1 } from "@googleapis/gmail";
import { getGmailClientWithRefresh } from "@/utils/gmail/client";
import prisma from "@/utils/prisma";
import { emailToContent, parseMessage } from "@/utils/mail";
import { GmailLabel } from "@/utils/gmail/label";
import type { RuleWithActionsAndCategories } from "@/utils/types";
import { getMessage } from "@/utils/gmail/message";
import type { UserAIFields } from "@/utils/llms/types";
import { hasAiAccess, hasColdEmailAccess, isPremium } from "@/utils/premium";
import { ColdEmailSetting, type User } from "@prisma/client";
import { runColdEmailBlocker } from "@/utils/cold-email/is-cold-email";
import { captureException } from "@/utils/error";
import { runRulesOnMessage } from "@/utils/ai/choose-rule/run-rules";
import { blockUnsubscribedEmails } from "@/app/api/google/webhook/block-unsubscribed-emails";
import { categorizeSender } from "@/utils/categorize/senders/categorize";
import { unwatchEmails } from "@/app/api/google/watch/controller";
import { createScopedLogger } from "@/utils/logger";
import { markMessageAsProcessing } from "@/utils/redis/message-processing";
import { isAssistantEmail } from "@/utils/assistant/is-assistant-email";
import { processAssistantEmail } from "@/utils/assistant/process-assistant-email";
import { handleOutboundReply } from "@/utils/reply-tracker/outbound";

const logger = createScopedLogger("Process History");

export async function processHistoryForUser(
  decodedData: {
    emailAddress: string;
    historyId: number;
  },
  options?: { startHistoryId?: string },
) {
  const { emailAddress, historyId } = decodedData;
  // All emails in the database are stored in lowercase
  // But it's possible that the email address in the webhook is not
  // So we need to convert it to lowercase
  const email = emailAddress.toLowerCase();

  const account = await prisma.account.findFirst({
    where: { user: { email }, provider: "google" },
    select: {
      access_token: true,
      refresh_token: true,
      expires_at: true,
      providerAccountId: true,
      userId: true,
      user: {
        select: {
          email: true,
          about: true,
          lastSyncedHistoryId: true,
          rules: {
            where: { enabled: true },
            include: { actions: true, categoryFilters: true },
          },
          coldEmailBlocker: true,
          coldEmailPrompt: true,
          aiProvider: true,
          aiModel: true,
          aiApiKey: true,
          premium: {
            select: {
              lemonSqueezyRenewsAt: true,
              coldEmailBlockerAccess: true,
              aiAutomationAccess: true,
            },
          },
          autoCategorizeSenders: true,
        },
      },
    },
  });

  if (!account) {
    logger.error("Account not found", { email });
    return NextResponse.json({ ok: true });
  }

  const premium = isPremium(account.user.premium?.lemonSqueezyRenewsAt || null)
    ? account.user.premium
    : undefined;

  if (!premium) {
    logger.info("Account not premium", {
      email,
      lemonSqueezyRenewsAt: account.user.premium?.lemonSqueezyRenewsAt,
    });
    await unwatchEmails(account);
    return NextResponse.json({ ok: true });
  }

  const userHasAiAccess = hasAiAccess(
    premium.aiAutomationAccess,
    account.user.aiApiKey,
  );
  const userHasColdEmailAccess = hasColdEmailAccess(
    premium.coldEmailBlockerAccess,
    account.user.aiApiKey,
  );

  if (!userHasAiAccess && !userHasColdEmailAccess) {
    logger.trace("Does not have hasAiOrColdEmailAccess", { email });
    await unwatchEmails(account);
    return NextResponse.json({ ok: true });
  }

  const hasAutomationRules = account.user.rules.length > 0;
  const shouldBlockColdEmails =
    account.user.coldEmailBlocker &&
    account.user.coldEmailBlocker !== ColdEmailSetting.DISABLED;
  if (!hasAutomationRules && !shouldBlockColdEmails) {
    logger.trace("Has no rules set and cold email blocker disabled", { email });
    return NextResponse.json({ ok: true });
  }

  if (!account.access_token || !account.refresh_token) {
    logger.error("Missing access or refresh token", { email });
    return NextResponse.json({ ok: true });
  }

  if (!account.user.email) {
    // shouldn't ever happen
    logger.error("Missing user email", { email });
    return NextResponse.json({ ok: true });
  }

  try {
    const gmail = await getGmailClientWithRefresh(
      {
        accessToken: account.access_token,
        refreshToken: account.refresh_token,
        expiryDate: account.expires_at,
      },
      account.providerAccountId,
    );

    // couldn't refresh the token
    if (!gmail) {
      logger.error("Failed to refresh token", { email });
      return NextResponse.json({ ok: true });
    }

    const startHistoryId =
      options?.startHistoryId ||
      Math.max(
        Number.parseInt(account.user.lastSyncedHistoryId || "0"),
        historyId - 500, // avoid going too far back
      ).toString();

    logger.info("Listing history", {
      startHistoryId,
      lastSyncedHistoryId: account.user.lastSyncedHistoryId,
      gmailHistoryId: startHistoryId,
      email,
    });

    const history = await gmail.users.history.list({
      userId: "me",
      // NOTE this can cause problems if we're way behind
      // NOTE this doesn't include startHistoryId in the results
      startHistoryId,
      labelId: GmailLabel.INBOX,
      historyTypes: ["messageAdded", "labelAdded"],
      maxResults: 500,
    });

    if (history.data.history) {
      logger.info("Processing history", {
        email,
        startHistoryId,
        historyId: history.data.historyId,
      });

      await processHistory({
        history: history.data.history,
        email,
        gmail,
        accessToken: account.access_token,
        hasAutomationRules,
        rules: account.user.rules,
        hasColdEmailAccess: userHasColdEmailAccess,
        hasAiAutomationAccess: userHasAiAccess,
        user: {
          id: account.userId,
          email: account.user.email,
          about: account.user.about || "",
          aiProvider: account.user.aiProvider,
          aiModel: account.user.aiModel,
          aiApiKey: account.user.aiApiKey,
          coldEmailPrompt: account.user.coldEmailPrompt,
          coldEmailBlocker: account.user.coldEmailBlocker,
          autoCategorizeSenders: account.user.autoCategorizeSenders,
        },
      });
    } else {
      logger.info("No history", {
        startHistoryId,
        decodedData,
      });

      // important to save this or we can get into a loop with never receiving history
      await updateLastSyncedHistoryId(account.user.email, historyId.toString());
    }

    logger.info("Completed processing history", { decodedData });

    return NextResponse.json({ ok: true });
  } catch (error) {
    captureException(error, { extra: { decodedData } }, email);
    logger.error("Error processing webhook", {
      decodedData,
      email,
      error:
        error instanceof Error
          ? {
              message: error.message,
              stack: error.stack,
              name: error.name,
            }
          : String(error),
    });
    return NextResponse.json({ error: true });
    // be careful about calling an error here with the wrong settings, as otherwise PubSub will call the webhook over and over
    // return NextResponse.error();
  }
}

type ProcessHistoryOptions = {
  history: gmail_v1.Schema$History[];
  email: string;
  gmail: gmail_v1.Gmail;
  accessToken: string;
  rules: RuleWithActionsAndCategories[];
  hasAutomationRules: boolean;
  hasColdEmailAccess: boolean;
  hasAiAutomationAccess: boolean;
  user: Pick<
    User,
    | "id"
    | "email"
    | "about"
    | "coldEmailPrompt"
    | "coldEmailBlocker"
    | "autoCategorizeSenders"
  > &
    UserAIFields;
};

async function processHistory(options: ProcessHistoryOptions) {
  const { history, email } = options;

  if (!history?.length) return;

  for (const h of history) {
    const historyMessages = [
      ...(h.messagesAdded || []),
      ...(h.labelsAdded || []),
    ];

    if (!historyMessages.length) continue;

    const inboxMessages = historyMessages.filter(
      (m) =>
        m.message?.labelIds?.includes(GmailLabel.INBOX) &&
        !m.message?.labelIds?.includes(GmailLabel.DRAFT),
    );
    const uniqueMessages = uniqBy(inboxMessages, (m) => m.message?.id);

    for (const m of uniqueMessages) {
      try {
        await processHistoryItem(m, options);
      } catch (error) {
        captureException(
          error,
          { extra: { email, messageId: m.message?.id } },
          email,
        );
        logger.error("Error processing history item", {
          email,
          messageId: m.message?.id,
          threadId: m.message?.threadId,
          error:
            error instanceof Error
              ? {
                  message: error.message,
                  stack: error.stack,
                  name: error.name,
                }
              : String(error),
        });
      }
    }
  }

  const lastSyncedHistoryId = history[history.length - 1].id;

  await updateLastSyncedHistoryId(email, lastSyncedHistoryId);
}

async function processHistoryItem(
  {
    message,
  }: gmail_v1.Schema$HistoryMessageAdded | gmail_v1.Schema$HistoryLabelAdded,
  {
    gmail,
    email: userEmail,
    user,
    accessToken,
    hasColdEmailAccess,
    hasAutomationRules,
    hasAiAutomationAccess,
    rules,
  }: ProcessHistoryOptions,
) {
  const messageId = message?.id;
  const threadId = message?.threadId;

  if (!messageId || !threadId) return;

  const loggerOptions = {
    email: userEmail,
    messageId,
    threadId,
  };

  const isFree = await markMessageAsProcessing({ userEmail, messageId });

  if (!isFree) {
    logger.info("Skipping. Message already being processed.", loggerOptions);
    return;
  }

  logger.info("Getting message", loggerOptions);

  try {
    const [gmailMessage, hasExistingRule] = await Promise.all([
      getMessage(messageId, gmail, "full"),
      prisma.executedRule.findUnique({
        where: {
          unique_user_thread_message: { userId: user.id, threadId, messageId },
        },
        select: { id: true },
      }),
    ]);

    // if the rule has already been executed, skip
    if (hasExistingRule) {
      logger.info("Skipping. Rule already exists.", loggerOptions);
      return;
    }

    const message = parseMessage(gmailMessage);

    const isForAssistant = isAssistantEmail({
      userEmail,
      emailToCheck: message.headers.to,
    });

    if (isForAssistant) {
      logger.info("Passing through assistant email.", loggerOptions);
      return processAssistantEmail({
        message,
        userEmail,
        userId: user.id,
        gmail,
      });
    }

    const isFromAssistant = isAssistantEmail({
      userEmail,
      emailToCheck: message.headers.from,
    });

    if (isFromAssistant) {
      logger.info("Skipping. Assistant email.", loggerOptions);
      return;
    }

    const isOutbound = message.labelIds?.includes(GmailLabel.SENT);

    if (isOutbound) {
      await handleOutboundReply(user, message, gmail);
      // skip outbound emails
      return;
    }

    // check if unsubscribed
    const blocked = await blockUnsubscribedEmails({
      from: message.headers.from,
      userId: user.id,
      gmail,
      messageId,
    });

    if (blocked) {
      logger.info("Skipping. Blocked unsubscribed email.", loggerOptions);
      return;
    }

    const shouldRunBlocker = shouldRunColdEmailBlocker(
      user.coldEmailBlocker,
      hasColdEmailAccess,
    );

    if (shouldRunBlocker) {
      logger.info("Running cold email blocker...", loggerOptions);

      const content = emailToContent(message);

      const response = await runColdEmailBlocker({
        email: {
          from: message.headers.from,
          subject: message.headers.subject,
          content,
          messageId,
          threadId,
          date: message.headers.date,
        },
        gmail,
        user,
      });

      if (response.isColdEmail) {
        logger.info("Skipping. Cold email detected.", loggerOptions);
        return;
      }
    }

    // categorize a sender if we haven't already
    // this is used for category filters in ai rules
    if (user.autoCategorizeSenders) {
      const sender = message.headers.from;
      const existingSender = await prisma.newsletter.findUnique({
        where: { email_userId: { email: sender, userId: user.id } },
        select: { category: true },
      });
      if (!existingSender?.category) {
        await categorizeSender(sender, user, gmail, accessToken);
      }
    }

    if (hasAutomationRules && hasAiAutomationAccess) {
      logger.info("Running rules...", loggerOptions);

      await runRulesOnMessage({
        gmail,
        message,
        rules,
        user,
        isTest: false,
      });
    }
  } catch (error: unknown) {
    // gmail bug or snoozed email: https://stackoverflow.com/questions/65290987/gmail-api-getmessage-method-returns-404-for-message-gotten-from-listhistory-meth
    if (
      error instanceof Error &&
      error.message === "Requested entity was not found."
    ) {
      logger.info("Message not found", loggerOptions);
      return;
    }

    throw error;
  }
}

export function shouldRunColdEmailBlocker(
  coldEmailBlocker: ColdEmailSetting | null,
  hasColdEmailAccess: boolean,
) {
  return (
    (coldEmailBlocker === ColdEmailSetting.ARCHIVE_AND_READ_AND_LABEL ||
      coldEmailBlocker === ColdEmailSetting.ARCHIVE_AND_LABEL ||
      coldEmailBlocker === ColdEmailSetting.LABEL) &&
    hasColdEmailAccess
  );
}

async function updateLastSyncedHistoryId(
  email: string,
  lastSyncedHistoryId?: string | null,
) {
  if (!lastSyncedHistoryId) return;
  await prisma.user.update({
    where: { email },
    data: { lastSyncedHistoryId },
  });
}
