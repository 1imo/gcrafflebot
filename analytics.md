# gcrafflebot analytics (`analytics_events`)

## Event catalog

### Onboarding

- `onboarding_start` — `/start` (`userId`)
- `onboarding_text` — text during onboarding (`userId`, `textLength`)
- `onboarding_completed` — auth success (`userId`)
- `onboarding_failed` — auth failed (`userId`, `error`)

### GC raffle flow

- `gcraffle_winner_count_prompted` — user tapped Groups (`userId`)
- `gcraffle_winner_count_invalid` — non-numeric winner input (`userId`, `input`)
- `gcraffle_winner_count_set` — valid winner count (`userId`, `winnersRequested`)
- `group_picker_opened` — group list shown (`userId`, `groupCount`, `winnersRequested`)
- `gcraffle_completed` — pull + draw finished (`userId`, `groupId`, `winnersRequested`, `membersPulled`, `winnersSelected`)

## DB columns (`group_member_exports`)

- `member_count` — humans stored from the group
- `winners_requested` — count the user asked for
- `winners_selected` — actual winners drawn (capped by pool size)

`group_member_export_members.is_winner` marks stored rows that were drawn.
