import type { GroupMemberExportRepository } from "../repositories/group-member-export-repository.js";
import type { SessionRepository } from "../repositories/session-repository.js";
import type { TdlibListenerService } from "../bg-services/tdlib-listener-service.js";
import type { GroupMemberExportService } from "../services/group-member-export-service.js";
import type { ClientNotificationService } from "../services/client-notification-service.js";
import type { GroupMember, GroupSummary, ServiceUser } from "../types.js";
import type { Analytics } from "../utils/analytics.js";
import {
  CANCEL_BUTTON,
  GROUPS_BUTTON,
  cancelKeyboard,
  groupPickerKeyboard,
  mainMenuKeyboard,
  truncateKeyboardLabel
} from "../utils/bot-keyboards.js";
import { parseWinnerCount } from "../utils/parse-winner-count.js";
import { pickRandomWinners } from "../utils/pick-winners.js";
import { chunkLines, formatMemberTelegramLink } from "../utils/telegram-links.js";
import type { Logger } from "../utils/logger.js";

type GroupOption = {
  label: string;
  chatId: string;
  title: string;
};

type PickerState =
  | { mode: "idle" }
  | { mode: "awaiting_winner_count" }
  | { mode: "picking_group"; options: GroupOption[]; winnerCount: number };

export class GroupPickerUseCase {
  private readonly state = new Map<number, PickerState>();

  constructor(
    private readonly sessions: SessionRepository,
    private readonly tdlib: TdlibListenerService,
    private readonly groupExport: GroupMemberExportService,
    private readonly exports: GroupMemberExportRepository,
    private readonly notifications: ClientNotificationService,
    private readonly analytics: Analytics,
    private readonly logger: Logger
  ) { }

  async showMainMenu(userId: number): Promise<void> {
    await this.notifications.sendToClient(
      String(userId),
      "Tap Groups to run a raffle for a groupchat — you'll pick how many winners to select, then a group.",
      mainMenuKeyboard()
    );
    this.state.set(userId, { mode: "idle" });
  }

  async onText(user: ServiceUser, text: string): Promise<void> {
    const session = await this.sessions.findByUserId(String(user.userId));
    if (!session?.active) {
      await this.notifications.sendToClient(
        String(user.userId),
        "Complete onboarding first with /start."
      );
      return;
    }

    const trimmed = text.trim();
    const current = this.state.get(user.userId) ?? { mode: "idle" };

    if (trimmed === CANCEL_BUTTON) {
      await this.showMainMenu(user.userId);
      return;
    }

    if (trimmed === GROUPS_BUTTON) {
      await this.promptWinnerCount(user);
      return;
    }

    if (current.mode === "awaiting_winner_count") {
      await this.handleWinnerCountInput(user, trimmed);
      return;
    }

    if (current.mode === "picking_group") {
      const match = current.options.find((option) => option.label === trimmed);
      if (!match) {
        await this.notifications.sendToClient(
          String(user.userId),
          "Choose a group from the keyboard, tap Groups to start over, or tap Cancel.",
          groupPickerKeyboard(current.options.map((option) => option.label))
        );
        return;
      }
      await this.exportGroup(user, match, current.winnerCount);
      return;
    }

    await this.notifications.sendToClient(
      String(user.userId),
      `Tap ${GROUPS_BUTTON} to run a GC raffle.`,
      mainMenuKeyboard()
    );
  }

  private async promptWinnerCount(user: ServiceUser): Promise<void> {
    this.state.set(user.userId, { mode: "awaiting_winner_count" });
    this.analytics.trackEvent("gcraffle_winner_count_prompted", { userId: user.userId });
    await this.notifications.sendToClient(
      String(user.userId),
      "How many winners should I pick? Reply with a number.",
      cancelKeyboard()
    );
  }

  private async handleWinnerCountInput(user: ServiceUser, text: string): Promise<void> {
    const winnerCount = parseWinnerCount(text);
    if (winnerCount === null) {
      this.analytics.trackEvent("gcraffle_winner_count_invalid", {
        userId: user.userId,
        input: text
      });
      await this.showMainMenu(user.userId);
      await this.notifications.sendToClient(String(user.userId), "Not a number.");
      return;
    }

    this.analytics.trackEvent("gcraffle_winner_count_set", {
      userId: user.userId,
      winnersRequested: winnerCount
    });
    await this.beginGroupSelection(user, winnerCount);
  }

  private async beginGroupSelection(user: ServiceUser, winnerCount: number): Promise<void> {
    const client = this.tdlib.getClient(String(user.userId));
    if (!client) {
      await this.showMainMenu(user.userId);
      await this.notifications.sendToClient(
        String(user.userId),
        "Your Telegram session is not connected. Send /start to reconnect."
      );
      return;
    }

    await this.notifications.sendToClient(String(user.userId), "Loading your groups…");

    try {
      const groups = await this.groupExport.listGroups(client);
      if (groups.length === 0) {
        await this.showMainMenu(user.userId);
        await this.notifications.sendToClient(String(user.userId), "No groups found on this account.");
        return;
      }

      const options = this.buildGroupOptions(groups);
      this.state.set(user.userId, { mode: "picking_group", options, winnerCount });
      this.analytics.trackEvent("group_picker_opened", {
        userId: user.userId,
        groupCount: options.length,
        winnersRequested: winnerCount
      });
      await this.notifications.sendToClient(
        String(user.userId),
        `Select a group ( ${winnerCount} winner${winnerCount === 1 ? "" : "s"} will be drawn ):`,
        groupPickerKeyboard(options.map((option) => option.label))
      );
    } catch (error) {
      this.logger.error("group_picker_list_failed", { userId: user.userId, error: String(error) });
      await this.showMainMenu(user.userId);
      await this.notifications.sendToClient(
        String(user.userId),
        "Could not load groups. Try again in a moment."
      );
    }
  }

  private buildGroupOptions(groups: GroupSummary[]): GroupOption[] {
    const usedLabels = new Map<string, number>();
    return groups.map((group) => {
      const base = truncateKeyboardLabel(group.title);
      const seen = usedLabels.get(base) ?? 0;
      usedLabels.set(base, seen + 1);
      const label = seen === 0 ? base : `${base} (${seen + 1})`;
      return { label, chatId: group.chatId, title: group.title };
    });
  }

  private async exportGroup(user: ServiceUser, group: GroupOption, winnersRequested: number): Promise<void> {
    const client = this.tdlib.getClient(String(user.userId));
    if (!client) {
      await this.showMainMenu(user.userId);
      await this.notifications.sendToClient(
        String(user.userId),
        "Your Telegram session is not connected. Send /start to reconnect."
      );
      return;
    }

    await this.notifications.sendToClient(
      String(user.userId),
      `Fetching members for “${group.title}”…`,
      cancelKeyboard()
    );

    try {
      const members = await this.groupExport.fetchMembers(client, group.chatId);
      const humans = members.filter((member) => !member.isBot);
      const winners = pickRandomWinners(humans, winnersRequested);
      const winnerIds = new Set(winners.map((member) => member.userId));
      const storedMembers: GroupMember[] = humans.map((member) => ({
        ...member,
        isWinner: winnerIds.has(member.userId)
      }));

      const winnersSelected = winners.length;
      await this.exports.saveExport(
        user,
        group.chatId,
        group.title,
        storedMembers,
        winnersRequested,
        winnersSelected
      );

      if (humans.length === 0) {
        await this.showMainMenu(user.userId);
        await this.notifications.sendToClient(
          String(user.userId),
          `No members found in “${group.title}”.`
        );
        return;
      }

      this.analytics.trackEvent("gcraffle_completed", {
        userId: user.userId,
        groupId: group.chatId,
        winnersRequested,
        membersPulled: humans.length,
        winnersSelected
      });

      const winnerLinks = winners.map((member) => formatMemberTelegramLink(member));
      const header =
        `Winners for “${group.title}” ( ${winnersSelected} of ${humans.length} members, ${winnersRequested} requested ):\n`;
      const chunks = chunkLines(winnerLinks);
      for (let i = 0; i < chunks.length; i++) {
        const prefix = i === 0 ? header : `Winners ( continued ${i + 1}/${chunks.length} ):\n`;
        await this.notifications.sendToClient(String(user.userId), `${prefix}${chunks[i]}`);
      }
      await this.showMainMenu(user.userId);
    } catch (error) {
      this.logger.error("gcraffle_failed", {
        userId: user.userId,
        groupId: group.chatId,
        error: String(error)
      });
      await this.showMainMenu(user.userId);
      await this.notifications.sendToClient(
        String(user.userId),
        "Raffle failed. Check that your account can see members in that group, then try again."
      );
    }
  }
}
