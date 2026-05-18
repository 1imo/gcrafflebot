import type { GroupMember, ServiceUser } from "../types.js";
import type { Store } from "../utils/db/root.js";

export class GroupMemberExportRepository {
  constructor(private readonly store: Store) {}

  async saveExport(
    requestedBy: ServiceUser,
    groupTelegramId: string,
    groupTitle: string,
    members: GroupMember[],
    winnersRequested: number,
    winnersSelected: number
  ): Promise<void> {
    const payload = members.map((member) => ({
      member_user_id: member.userId,
      username: member.username ?? "",
      first_name: member.firstName,
      last_name: member.lastName,
      is_bot: member.isBot,
      is_premium: member.isPremium ?? null,
      phone: member.phone ?? "",
      is_winner: member.isWinner === true
    }));

    await this.store.write(
      "group_exports.create_with_members",
      requestedBy.userId,
      requestedBy.username,
      groupTelegramId,
      groupTitle,
      payload,
      winnersRequested,
      winnersSelected,
      new Date().toISOString()
    );
  }
}
