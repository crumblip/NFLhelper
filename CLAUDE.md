# NFLhelper — project memory

Fantasy football draft and waiver tool. Compares **sportsbook prop lines** and
**on-field usage** against **ADP** to find value. Half-PPR, 12-team.

Read this file first. It records decisions, calibrations and bug families that
are expensive to rediscover. Start with **How this breaks** — every bug in this
project has been an instance of one of seven patterns, and knowing the patterns
is worth more than knowing the instances.

## How to work on this — read before touching anything

The single most useful habit here: **when a result looks wrong, find the root
cause and fix it for everyone, not for the player who exposed it.** Every entry
in the bug list below was found through one player and was never about him.

1. **Measure before you build.** Every threshold, weight and feature in this
   project is backed by a `calibrate:*` script. If you are about to pick a
   number, write the script that picks it instead. A judgment number that fires
   on 58% of tight ends is how bug #70 happened — twice, because the first fix
   used judgment too.
2. **The partial is the test, never the raw correlation.** A metric that
   restates target share is not a second opinion. And a real partial still does
   not earn a place in the projection: that needs leave-one-season-out CV
   (`calibrate:model`), because in-sample R² rises whenever a column is added.
3. **Coverage beats fit.** A feature that improves R² but drops 90 players makes
   the board worse — the players it drops are the ones nobody else is projecting.
4. **An audit check can have the bug it is hunting.** This has happened at least
   five times (#33, and three separate wrong versions of the receipt checks).
   Before trusting a failing check, verify the check.
5. **Report what does not work.** Several of the most valuable findings here are
   negatives: scheme fit, run blocking, team injury proneness, trend. They are
   recorded so nobody re-adds them.
6. **Never present a default, a clamp or a fallback as a measurement** — that is
   families #6 and #7 and it accounts for a third of the bug list.

---

## League settings (drive everything downstream)

- **Half-PPR, 12 teams**
- Starters: **1 QB · 3 WR · 2 RB · 1 TE · 1 W/R/T flex · 1 DEF · 5 bench · 2 IR**
- Replacement ranks: **QB12 · RB29 · WR43 · TE13** (WR43 because 3 WR + flex)
- The bench is almost entirely WR/RB. **~11 of 13 picks are WR/RB — analysis
  should prioritise those two positions.** QB and TE are one-and-done.

## The user

Knows football well. Wants rigorous, calibrated statistics — not heuristics
dressed up as analysis.

**He is usually right when he says a result looks wrong**, and he has caught
several real bugs from a single screenshot. When he points at one player, the
job is to find the *root cause* that produced it, not to special-case that
player. He has explicitly asked for the scout's role: vet his claims, reinforce
them when they are weak, and prove them wrong when they are wrong — do not
rationalise a result to match what he expects.

He values honest reporting of what does not work, including when his own
hypotheses fail. Two examples he accepted: small-sample shares do *not* need
shrinking (measured, k≈0), and chasing a snap-share spike does not predict.

---

## Run order

```bash
npm run ingest:nflverse      # players, weekly stats, snap counts
npm run ingest:adp           # FFC ADP, 2018-2026
npm run resolve:players      # name -> gsis_id
npm run ingest:situation     # draft picks + depth charts
npm run ingest:usage         # participation, PFR, FTN, red zone (~100MB pbp/season)
npm run ingest:context       # team offence, QB EPA/dropback, run direction (same pbp)
npm run calibrate:dispersion
npm run refresh              # props -> baseline -> values -> usage grade -> blend -> outlook -> audit
npm run dev                  # localhost:3000
```

Connecting a Yahoo league (optional, one-time consent then re-run as needed):

```bash
npm run yahoo:auth           # browser consent, paste the code back, lists your leagues
npm run ingest:yahoo         # teams, rosters, waivers -> real availability on the wire
```

**`npm run audit` runs 90 invariant checks and is wired into `refresh`**, exiting
non-zero on failure. It is negative-tested: injected bugs are caught and rolled
back. **When a new bug turns up, add a check for its family rather than only
fixing the instance.**

Other entry points: `npm run waiver [POS]` · `npm run explain "<name>"` ·
`npm run refresh:adp` before drafting. API key via arg or `PARLAY_API_KEY`.

Calibration scripts that document findings rather than build anything:
`calibrate:recency` (in-season weighting), `calibrate:shrinkage` (small samples),
`calibrate:usage`, `calibrate:inseason`, `calibrate:risk`, `calibrate:trend`,
`calibrate:comparables` (backtests the outlook panel — ablation table plus
interval coverage; run it after touching the feature set or the weights),
`calibrate:advanced` (advanced metrics vs next season, raw AND after the
position's volume metric — the partial is the test, and it is the number quoted
on the scouting panel), `calibrate:model` (leave-one-season-out cross validation
for whether a feature belongs in the projection at all — in-sample R² always
rises, so it is never the test), `calibrate:coaching` (play callers, coaching changes, the offensive line),
`calibrate:availability` (shrinkage for expected games, and whether injury is a
team trait), `calibrate:blend` (replays four drafts with draft-day information
only and sweeps the market/usage weight — the script that was said to be
impossible without a prop archive; see **The 60/40 split is measured** below),
`calibrate:gems` (whether the board can find a gem or a bust at all — measures
against the SLOT, not against replacement, which is the whole argument),
`calibrate:opportunity` (who inherits vacated volume — the answer is **nobody**;
see the finding below before touching any opportunity code),
`calibrate:lateboard` (whether splitting the late board by who held a role
recovers signal — it does), `diagnose:deadband` (why the middle of the draft
predicts badly for every signal, not just this board's),
`calibrate:startable` (whether week-to-week startability adds anything over a
season total — it does not), `calibrate:upside` (rebuilds the comparables season
by season to test whether UPSIDE really outranks VALUE late — it does, but only
from round 11, it is NEGATIVE in rounds 7-10, and its partial test shows UPSIDE
and BUST are one measurement shown twice).

**Never run `next build` while `next dev` is running** — it corrupts `.next` and
produces `__webpack_modules__ is not a function`. Delete `.next` and restart.

---

## Data sources

| Source | Notes |
|---|---|
| ParlayAPI | **Use `/v1/sports/{sport}/odds/props`** — the documented `/props` returns `[]` for every sport and still bills 3 credits. Free tier 1000/mo. |
| FFC ADP | `/api/v1/adp/half-ppr?teams=12&year=YYYY`. **The `teams` param is cosmetic** — same data for 10/12/14. Rolling window; re-ingest before drafting. |
| nflverse `stats_player` | **Not `player_stats`** — that release is frozen at 2024 and returns 200 with a stale file. |
| nflverse `pbp_participation` | Route / pass-snap share. **Available from at least 2021** — an earlier comment claiming 2023+ was wrong and cost the comparables model two seasons of pool. |
| nflverse `pbp` | Red zone / goal line. ~100MB per season. |
| nflverse `draft_picks`, `depth_charts` | 2026 present. Depth charts refresh daily and are **90-man camp rosters** — Cleveland lists 11 WRs. |
| Yahoo Fantasy | OAuth2, scope `fspt-r`, free. Collections arrive as numeric-keyed objects and entity metadata as arrays of single-key objects — use `collection()` / `flatten()` in `lib/providers/yahoo/client.ts`, never index by position. Every number is a string. Stat ids are mapped from `/game/nfl/stat_categories` rather than a hard-coded table. |

**Market coverage is thin and it matters.** Only 12 of 56 RBs and 42 of 80 WRs
have a full market read; 22 RBs and 38 WRs have none at all. The WR/RB board
leans heavily on the usage side. Mahomes has *no season props at all* — only game
lines — and extrapolation is restricted to yardage, so "no betting lines" is
often accurate about the feed rather than a bug.

---

## How this breaks — seven families

Every numbered bug below was an instance of one of these. Check the family
before writing a fix; the instance is rarely alone.

1. **Position dispatch.** Code branching `isRb ? x : y` silently hands
   quarterbacks the receiver path. Grep for `isRb ?` and `position === 'RB' ?`
   whenever touching per-position logic.
2. **Dead threshold.** A cutoff that fires on all or none of a group carries no
   information. If a tag hits >80% of a position, it is not a finding.
3. **Cross-position comparison.** Metrics whose distributions differ by position
   must be ranked *within* position. Absolute cutoffs silently select one
   position.
4. **Stale fact.** Last season's team or role asserted as current. Always check
   the live depth chart before making a present-tense claim.
5. **Scale mismatch.** The usage model is regressed; its output must never be
   compared to an actual-points threshold.
6. **Default shown as measurement.** A prior rendered as a number implies
   knowledge that does not exist. If nothing was measured, say so.
7. **Unlabelled number.** Any figure on screen must be self-labelling *where it
   appears* — not explained in a paragraph underneath.

---

## Calibrated findings (measured, do not re-guess)

**Usage predicting NEXT season (r):**
- WR: target share .71 · air yards .67 · route share .63 · red-zone share .63
- RB: rush share .72 · red-zone touch share .72 · goal-line share .67
- TE: target share .76 (beats prior-season points at .72)
- QB: starter share dominates, but the position stays the weakest — **R²=0.36**
  in-sample, **0.30 out-of-sample** after adding offence EPA per dropback (was
  0.18). Still well below
  WR/TE/RB (~0.55). Say so when reporting a QB usage grade.
- **Dead**: aDOT (.11), YAC/reception (.01), yards before/after contact (.14)

**Chances beat conversions**: RB red-zone touch share (.72) > total TDs (.63).

**Trend does NOT predict.** After removing current level, year-over-year change
correlates at **−0.24** (WR route share). Breakouts regress. Do not add a trend
term. Age does predict: **−0.27 WR, −0.18 RB, −0.14 TE**.

**Small samples do NOT need shrinking** (`calibrate:shrinkage`, 540 season
pairs). Best k is **0 for rush share** (0.0% better), 1 for target (3.1%), 3 for
red-zone (4.4%). A 4-game rush share predicts next season's at **r=0.919** —
share reflects a coaching decision, not a noisy count. Do not "fix" a surprising
small-sample result by regressing it away.

**Within a season, do NOT weight recent games more** (`calibrate:recency`,
22,405 samples). Season-to-date beats a last-3 window at every position and every
stage: RB .749 v .730, WR .737 v .711, TE .715 v .693. Optimal blend puts 0.2 on
the recent window for a gain of 0.0007.

**Chasing a snap-share spike does not work.** Last-3 snap share 15pp **above**
season average → **6.77** rest-of-season PPG vs **6.84** for flat roles. No edge,
and predictability collapses to r=**0.25** — a spike is usually someone else's
one-week absence.

**A snap-share collapse is real and asymmetric.** 15pp **below** → **5.62** PPG,
a loss of **1.23**, and there the recent window *does* predict better (.461 v
.441). The wire flags shrinking roles and deliberately has no "trending up" tier.

**In-season handover**: current-season usage overtakes prior-season after **2
games**. Curve `g/(g+1.5)`, applied via `resolveUsageSeason()`.

**Durability is highly repeatable**: r≈0.42. A WR who missed 4+ games misses
again **73%** of the time vs **41%** for healthy. Source it from `snap_counts`
appearances, not `player_usage.games`.

**TD regression is real**: scoring above red-zone volume carries over at r=0.12
(WR), 0.03 (TE). Mostly luck.

**Team offence matters**: team offensive TDs predict a player's next-season TD
rate at **+0.15** after his own red-zone share is removed.

**Season-to-game prop ratio is 15.2, not 17** — season lines already discount
missed time.

**Rookie draft capital**: top-15 WR hits 64% / round 2 hits 14%. RB top-15 100%
(n=4, thin). TE top-15 80%.

**Comparables must include production, not just role** (`calibrate:comparables`,
1634 player-seasons). Adding points per game at weight 3.0 lifts next-season
correlation WR .746→.770, RB .690→.712, QB .509→.579; availability at 0.5 adds a
little more. Without it a 60% rush share is a 60% rush share whether the player
scored 335 or 217, which is how Bijan Robinson's closest analogue came back as
Rhamondre Stevenson.

**Comparables who never played again must stay in the pool.** Requiring a
following-year stat line dropped 13% of RB and 15% of WR role-holding seasons —
the worst outcome in fantasy football — and made every bust rate optimistic.
Keep them at zero for the *rates*; draw floor/median/ceiling from the ones who
played. Measured both ways: split gives interval coverage 0.60/0.63/0.58
(RB/WR/TE) against a 0.60 target, mixed gives 0.66/0.66/0.66.

**A thin neighbourhood breaks the midpoint, not the range.** Bucketing by the
share of the 40 that are genuine matches, mean absolute error roughly doubles
(RB 33.5 → 65.6, WR 28.3 → 41.1, TE 15.3 → 34.9) while interval coverage holds
near 0.60 in every bucket. So report support and tell the reader to read the
spread — do not suppress the range.

**k=40 is right at every position** (swept 10–60). Adaptive radius neighbourhoods
were tested and lose on MAE, r and coverage.

**Advanced metrics** (`calibrate:advanced`, partial r against next season after
the position's volume metric — the raw r is not the test, because a metric that
restates target share is not a second opinion):

| metric | WR | RB | note |
|---|---|---|---|
| **first downs** | **.387** | **.338** | strongest independent signal in the project. Raw r .773 for WR — higher than target share itself |
| yards per carry | — | .274 | efficiency usually regresses; for backs it does not entirely |
| EPA per touch | .189 | .261 | |
| RB target share | — | .259 | receiving work is the least replaceable part of a backfield |
| RB yards/route | — | .257 | |
| age | .254 | .176 | |
| team points scored | .204 | .139 | |
| QB EPA/dropback | .193 | — | |
| first-down rate | .184 | .209 | |
| yards per route | .152 | — | separates receivers earning volume from receivers given it |
| yards after contact | — | .153 | weak but NOT dead — the old .14 reading was roughly right, the conclusion was too harsh |
| TE yards/route | .034 | — | target share absorbs it entirely |

**The five-filter WR1 screen works — as a forward screen, not as a law.**
Under 30 · 25%+ target share · 2.3+ yards per route · top-11 scoring offence ·
top-10 QB by EPA/dropback. Three of five WR1s cleared all five (Jefferson 2022
missed only QB rank 12; Chase 2024 missed only 2.27 yprr against 2.30), so "every
WR1 has these" is false. But applied in season N and judged on N+1: cleared →
**228 points, 62% top-12**; held a real role and did not clear → **142 points,
20% top-12**. A three-fold lift, and the strongest single screen here.
Individually the five are modest (~.20 each); together they are not redundant.

**Scheme fit does NOT predict, and cannot.** A back's per-carry edge outside over
interior does not persist year to year at all — **r = −0.010** across 104
consecutive-season pairs — so there is no stable trait for a scheme to suit.
Matching that edge to his next team's tendency returns nothing: best-fit third
**147.5** next-season points against **146.7** for worst-fit. Outside-run share
(.173) and team outside tendency (.021) are both dead. The league premise is
unstable too: outside beat interior by 0.16 and 0.11 yards in 2021-22, then LOST
by 0.11 and 0.15 in 2023-24. Run direction is shown on the player page as
description and is deliberately not scored.

**nflverse charts no blocking scheme.** There is no zone/gap flag in any public
release. `run_location` / `run_gap` give direction only. True zone/gap is PFF or
Sports Info Solutions, both paid — do not claim zone-vs-gap from this data.

**The offensive line** (`calibrate:coaching`). All the line metrics are genuinely
**stable** year to year — yards before contact r=0.384, pass-block rank r=0.462,
sack rate r=0.384 — so unlike scheme fit they *could* forecast. Then:

- **Run blocking does NOT predict RB fantasy points.** Yards before contact,
  run-block rank and stuff rate all land at **0.02–0.08** partial after rush
  share. Cross-validated, adding YBC to the RB model gives +0.015 against team
  points' +0.020 — it loses. Fantasy scoring is volume and touchdowns, and
  volume is the coach's decision, not the line's. Counterintuitive and repeatedly
  measured; do not re-add it.
- **Pass protection DOES predict QB fantasy** — partial **0.256** (block rank)
  and **0.280** (sack rate). But it is *absorbed*: cross-validated, `qbEpa +
  protection` returns 0.303 against 0.299 for `qbEpa` alone. **+0.004 is not
  worth a parameter**, so the QB model keeps EPA only. Protection matters
  *through* offensive efficiency, which the model already has. A textbook case of
  two correlated predictors each looking informative and jointly adding nothing.

**Play callers** (`head_coach` from pbp — nflverse publishes no coordinator
table anywhere, so this is head coach and is named that):

- **A coaching change costs a running back ~12 points.** Backs who stayed with
  their team lost 24.5 points under a new coach against 12.5 under the same one
  (n=150 v 188). WR −4.5, TE −0.2, QB **+19.6** — and the QB number is a confound,
  since coaches get fired *because* the quarterback played badly, so the next
  season regresses upward.
- **Backfield concentration is partly a property of the coach.** The top back's
  share of carries repeats at **r=0.337** when the coach stays and only **r=0.107**
  when the team changes coach — a three-fold difference, so it travels with the
  man rather than the roster. Most concentrated: Steichen 68.4%, **Zac Taylor
  65.8%**, Vrabel 64.8%, Callahan 63.0%. Least: Quinn 38.9%, Arthur Smith 40.6%,
  Harbaugh 44.3%, Andy Reid 47.8%. Sample is 2–5 seasons per coach — directionally
  real, individually thin.

**The market prices late-round upside efficiently, and that is why "cheap AND
high upside" barely exists.** Of 118 players going after pick 60: 46 are young
or rookies, 26 of those are not already overpriced, and **exactly 1** of those 26
sits in the top quartile of breakout rate for his own position and draft band.
Genuine late upside gets bid up. So the useful surface is `late-upside`
("startable upside", 25 players) which does NOT require a discount, and `gem` is
the rare intersection that does. Do not "fix" an empty gem list by loosening it
— the emptiness is a real property of the market.

**Rookie draft capital is weaker than the price already knows** (78 rookies,
2021-2025, with both an ADP and a draft pick):

| | ADP r | draft pick r | pick AFTER adp |
|---|---|---|---|
| WR (n=29) | .453 | .419 | **.206** |
| RB (n=34) | .502 | .244 | **−.104** |

ADP is the better of the two at both positions, and for backs draft capital adds
**nothing** once the price is known. `projectRookie` was nonetheless blended at
the normal 40% — the weight given to a ridge model fitted on measured usage with
R²≈0.60 — which counts capital twice, since the market already prices where a
player was drafted. Carnell Tate came out at 167 from capital against a market
read of 139. Now: market weight 0.85 for WR/TE and 1.0 for RB when a market read
exists, and when there is none the projection is pulled toward the ADP slot
(80% for WR/TE, entirely for RB) instead of being exempt from shrinkage as it was.
Samples are 29 and 34, so this is a blunt correction rather than a fitted weight.

**Availability needs NO shrinkage** (`calibrate:availability`, 2,367 season
pairs, 2018-2025). Predicting next season's games from prior games, sweeping
k in `(observed·seasons + posMean·k)/(seasons + k)`:

| k | 0 | 0.5 | 1 | 2 | 3 | 5 |
|---|---|---|---|---|---|---|
| r | **.558** | .562 | .558 | .542 | .522 | .481 |
| MAE | **4.59** | 4.73 | 4.90 | 5.14 | 5.30 | 5.50 |

k=0 wins on error and ties on correlation, and it still wins restricted to
players with **one** season of history (n=990, r .548, MAE 4.51). So a rookie
who played 17 games genuinely reads as durable — Ashton Jeanty's `expectedGames`
of 17.0 off a single season is correct, not overconfident. Same shape as the
shares finding: do not "fix" this by regressing it toward a mean.

**Team-level injury proneness does NOT predict.** Tested because the 49ers'
reputation is real enough to be worth checking. Team availability (mean games by
its skill players) repeats year to year at **r=0.079**, against **0.42** for an
individual player. Restricting to each team's core eight by snaps — removing
roster churn from the instrument — barely moves it: persistence **0.109**, and
predicting a player's next-season games gives r=0.103 raw and **0.043** after
his own record. San Francisco does rank 4th-fewest games among its core eight
(14.15), so the reputation is descriptively true and carries no forward signal.
Injury risk belongs on the player and is already there; do not add a team term.

**The 60/40 split is measured now, and it is right — but for a reason that
matters more than the number** (`calibrate:blend`, 509 player-seasons, four
drafts replayed 2022-2025 with draft-day information only, leave-one-season-out).

The blocker was always "no historical prop archive". True, and it hid the fact
that **ADP is an archived market** going back to 2018. On the 2026 board ADP and
the prop-implied points correlate at **.98 WR · .93 RB · .95 TE · .86 QB**, so a
weight measured against ADP transfers. Sweeping the market weight 0 to 1:

| | usage only | 0.4 | **0.6** | 0.8 | market only | best w | cost of shipping 0.6 |
|---|---|---|---|---|---|---|---|
| ALL | .451 | .496 | **.506** | .507 | .499 | 0.70 | **0.0015** |
| WR | .548 | .580 | **.584** | .579 | .567 | **0.60** | **0.0000** |
| RB | .424 | .484 | **.499** | .502 | .494 | 0.75 | 0.0032 |
| TE | .346 | .429 | **.457** | .472 | .475 | 0.95 | 0.0183 |
| QB | .322 | .337 | **.340** | .338 | .333 | 0.65 | 0.0000 |

**The objective is flat between 0.5 and 0.9** — bootstrap 90% CI on the argmax is
[0.50, 0.90] pooled, [0.35, 0.85] for WR, and the whole [0,1] range for QB. The
finding is not "0.6 is optimal", it is **"the data cannot tell 0.6 from 0.8, and
0.6 costs 0.0015 of correlation against a perfectly-tuned weight."** WR — the
position 11 of 13 picks come from — puts the optimum at exactly 0.60. Do not
re-tune this to chase a third decimal.

**Per-position weights do NOT generalise.** Picking the weight on three seasons
and using it on the fourth: tuned **.5005** against flat 0.6 at **.5051**. TE
tuning gained .039 twice and lost .023 once; QB lost .039. The flat number is the
honest one. (Same shape as the `k=0` findings: a tempting refinement that the
sample cannot support.)

**The usage side does add something the price has not priced — except at TE.**
Partial r of the usage projection against next-season points, after ADP:

| | usage alone | market alone | **usage AFTER market** | market after usage |
|---|---|---|---|---|
| WR | .548 | .567 | **.168** | .241 |
| RB | .424 | .494 | **.105** | .297 |
| QB | .322 | .333 | **.069** | .115 |
| TE | .346 | .475 | **.018** | .347 |

**TE usage is dead weight on the blend** — partial .018, optimum w=0.95, and the
3-season blend actually predicts *worse* than a single season (.370 v .409). A
tight end's price already contains his role. The 0.6 default costs TEs 0.018 of
correlation, the largest cost of any position, on 10 board players.

**Where the two disagree, the market wins on ranking and usage wins on
direction.** Inside a disagreement bucket the market is the better sorter
(r .652 v .480 at 1.0-1.5 z apart, best w there 0.80). But the residual against
price is **monotone in disagreement** — 1.0+ z above the market → beat his price
by **+0.338 z**; agree → −0.023; 1.0+ z below → **−0.652 z**. So `disagreement`
is a genuine value signal and the tags built on it are earned; it is just not a
better *ranking* than the price. Both statements are true and they are about
different questions.

**The usage model beats naive baselines only at WR.** Against prior-season points
per game x17, out of sample: WR .538 v .497, RB .411 v .402, QB .303 v .332,
TE .370 v .510. At TE and QB a one-line baseline beats the ridge model. The
pooled figure (.568 v .562) flatters it by mixing positions with different
scoring scales — always read the per-position rows.

**The 3-season recency blend `[0.6, 0.28, 0.12] x games/17` is NOT calibrated.**
The model is *fitted* on single-season features and *applied* to a multi-season
weighted average — different objects. Measured, it helps QB (.241 -> .303), is
neutral for WR (.537 -> .538), and hurts RB (.418 -> .411) and TE (.409 -> .370).
Net pooled it is positive only because of QB. The `games/17` term is also in
direct tension with `calibrate:shrinkage`, which found k=0 — shares do not need
regressing toward a mean. Worth a proper sweep of the recency vector; nobody has
done one.

**Why the board finds no gems and no busts** (`calibrate:gems`, 590 drafted
player-seasons 2022-2025, everything within position and measured against the
SLOT rather than against replacement). Five separate things, and only some of
them are fixable.

1. **VALUE reproduces the draft board.** Spearman against draft order: **ALL
   .905 · WR .918 · RB .956 · TE .875 · QB .765.** The market is 60% of the blend
   and the market is .93-.98 correlated with ADP, so VALUE is very nearly a
   monotone function of ADP with a small usage tilt. *A board that reproduces
   ADP cannot disagree with it, and disagreeing with it is the only way a gem or
   a bust can exist.*
2. **"Bust" is defined against the wrong thing.** The tag and the verdict both
   key off replacement. A drafter means *returned less than the pick cost*. At
   the top those differ wildly: **Brian Thomas Jr, ADP 14 in 2025, returned +5
   VORP** — a catastrophe at that price and a pass under the shipped rule.
   Austin Ekeler 2023 went 3rd and returned +6 against a slot worth +129. **14 of
   245 early picks cleared replacement while returning 40+ below their slot** and
   every one is invisible. The right target is the slot residual, and `slot_gap`
   is already that quantity — see (3) for why it does not work either.
3. **`slot_gap` is dominated by which round a player is in.** Mean by round:
   1-5 sit at −1.5 to +1.8, then **round 7 +20.1 (93% positive), round 9 +27.4
   (92% positive)**. The historical return craters after round 7 (mean VORP −8,
   −35, −34) faster than the projections do, so "cheap" becomes a property of the
   round rather than of the player. It needs ranking **within a draft band**, the
   way `ratePctile` already does for breakout and bust rates — family #3.
4. **The confidence shrinkage is over-calibrated by a wide margin.**
   `min(1, seasons/3) x min(1, games/12)` keeps **0%** of a rookie's own number
   (20% for WR/TE) and **33%** of a second-year player's, replacing the rest with
   his draft slot. Its premise is "a short record is noisier", which is *partly*
   true — for late picks the usage projection's MAE is **65.3** at 0-1 seasons
   against **50.6** at 2+ — but the projection *ranks* just as well (r .536 v
   .527), and the spread of outcomes around the slot does **not** fall with
   experience (early: rookie 43 → 3+ seasons 77; late: 70 → 57). A 29% error
   increase does not justify a 67-100% haircut. **This is the single biggest
   structural reason no gem can surface**: it discounts hardest exactly the group
   with the highest late-round hit rate — **rookies hit 42%, 0-1 seasons 36%,
   2 seasons 22%, 3+ seasons 30%.**
5. **Predicting WHICH early pick busts is close to a coin flip on this data.**
   Within position, against the slot residual, every candidate lands inside
   ±0.15: WR pass-snap share +.085, target share +.058, first downs/game +.097,
   age −.113; RB seasons of history +.247 (the strongest, and it says
   *experienced* backs beat their price), rush share +.055, first downs −.081.
   The **disagreement** signal — the one the board already computes — carries
   **r = 0.115 early, 0.112 late** against the residual. Real, consistent, and
   far too weak to name a bust with confidence. **Any tag claiming to do it is
   claiming more than the data supports**, and the honest surface is a ranked
   lean, not a label.

**The late-round gem profile that DOES hold: a short record plus real draft
capital.** Over 193 picks at ADP 100+ (2022-2025), share clearing replacement
against a **31% base rate**:

| gate | hit rate | n |
|---|---|---|
| young (≤25 or rookie) | 36% | 100 |
| short record (rookie or ≤1 season) | 39% | 83 |
| capital inside pick 100 | 38% | 98 |
| short record AND capital ≤ 100 | 46% | 50 |
| **short record AND capital ≤ 60** | **59%** | **37** |
| veteran, 3+ seasons (contrast) | 30% | 47 |

Mean VORP goes −35 → −10, it beats the base rate in **all four seasons**
(67/48 · 33/28 · 38/26 · 50/34), and the lift is **general across positions** —
WR +18pp, RB +67pp (n=4, thin), TE +34pp, QB +26pp against each position's own
base. WR/RB alone: **29% → 55%**, mean VORP −34 → +9. It names Josh Jacobs 2022,
Brian Thomas Jr 2024, Christian Kirk, Jordan Addison, Zay Flowers, Chris Olave,
Drake London, Pickens, Judkins, Charbonnet — and honestly misses on Skyy Moore,
Adonai Mitchell, Kadarius Toney.

**Draft capital works here while adding nothing to the projection, and that is
not a contradiction — it is conditional.** ADP already prices capital league-wide
(pick adds .206 for WR after ADP, −.104 for RB). But *among players the market
has given up on*, capital separates a former high pick who has not had his chance
from a career backup. Different population, different question.

**The bust tag's age reason is backwards for running backs.** It fires on "aging
and already missing time" at age ≥28 for RB and ≥30 otherwise. Measured against
the slot residual: WR r(age) **−0.113** (old receivers return −17 against price,
younger +4) — weak but the right sign. RB r(age) **+0.060**, and backs at 28+
return −7 against price versus +7 for younger, so the effect is a rounding error
and the correlation points the other way. Do not use age as a bust reason for
backs on this evidence.

**The uncovered player's confidence is 0.30, flat, and measured.** For a player
no book prices, the shrinkage toward his ADP slot is just a two-signal blend —
the slot IS his market — so it sweeps like any other weight. LOSO, 509
player-seasons:

| rule | r |
|---|---|
| **flat 0.30** | **.5065** |
| flat 0.20 / 0.40 | .5057 / .5050 |
| always the slot (0) | .4979 |
| `min(1,seasons/3) x min(1,games/12)` | **.4891** ← what shipped |
| always his own number (1) | .4500 |

**Seasons of history do not predict who beats their draft slot**, and the rule
built on them lost to a constant in all four folds. Per position the optima are
WR .40 · RB .25 · TE .05 · QB .35 and 0.30 costs ≤.009 against any — per-position
tuning failed to generalise here exactly as it did for the market weight. The
games term added +.0008 and was dropped: availability is already taken off the
usage side by the durability multiplier, and charging it twice is what that
step's own comment warns against. **This does not reintroduce #68** — that bug
was an asymmetry where uncovered players were pulled and covered ones were not.
Covered players are pulled 60% by the market; 70% by the slot here is the same
structure, and the old rule's 100%-own-number for a veteran was the real
asymmetry, in the opposite direction.

**Demeaning the slot gap within a draft band was TESTED AND REJECTED.** It was
the obvious fix for the round-7 hump and it makes things worse: pooled
correlation with the price residual falls **.250 → .160**, and inside a band a
monotone recentring cannot reorder anything anyway. The gap is not miscalibrated
in rounds 7-10, it is **uninformative** there (r .041 against .296 in rounds
1-3), and the honest response to an uninformative number is to say so. Hence the
`gap-unreliable` tag, which suppresses the price verdict for picks 73-120.

**VACATED VOLUME DOES NOT REACH THE MAN BEHIND IT** (`calibrate:opportunity`,
1,117 incumbent player-seasons, 2021-2025). The largest negative finding in the
project, and it invalidates a whole feature.

The question: a team loses volume; how much reaches the incumbents? The raw gain
is confounded, because share is bounded and reverts — a back holding 68% can only
fall, so Dameon Pierce 74%→39% lands in the same average as Chase Brown 16%→64%.
The specification that answers it holds prior share fixed:

`nextShare = a + b x priorShare + c x vacated`, where **c is the inheritance rate**:

| pool | queue 1 | queue 2 | queue 3 | queue 4+ |
|---|---|---|---|---|
| target | **−0.022** (t −1.1) | −0.003 | −0.034 | −0.001 |
| rush | **−0.027** (t −0.5) | −0.070 | +0.081 | — |

**Not one coefficient reaches two standard errors, and every point estimate is
negative.** The shipped rule assumes **0.60 / 0.25 / 0.15** reaches queue 1/2/3 —
the target queue-1 figure is ~30 standard errors away from what ships.

**It is not collinearity.** corr(prior share, vacated) is only −0.44 to −0.54, and
the collinearity-free version of the test — regressing next share on prior share
alone, then correlating the residual with vacated — gives **−0.087 · −0.013 ·
−0.040 · −0.161**. Same answer.

**And it does not predict points.** Partial correlation of vacated share against
next-season fantasy points, after the player's own prior share: **−0.038**
(target), **−0.024** (rush), −0.065 / −0.171 for first-in-line only. This settles
known-gap #7 in the negative: **opportunity does not belong in the projection,
and it does not belong in the tags either.**

**What actually happens is that teams REPLACE departed volume.** Mean first-season
share by draft round — round 1 takes **20.2%** of targets (WR/TE) and **56.0%** of
carries (RB); round 2 11.7% / 38.5%; round 3 8.2% / 24.0%; rounds 4-7 6.3% /
16.6%. The volume goes to new players, not down the depth chart.

**Vacancy is variance, not a forecast.** The individual cases are dramatic in both
directions — Jaxon Smith-Njigba 24%→36% and Trey McBride 20%→29% against Brian
Thomas Jr 25%→19% and DJ Moore 27%→16%, all with 20%+ walking out. Mean ≈ 0,
spread enormous. Anything built on it must say "this could go either way", never
"he is next in line".

**SCOPE — this is about OFFSEASON departures only.** The measurement compares a
player's share in season S-1 against S, where "departed" means gone from the
roster. It says nothing about **in-season replacement** — a starter going down in
October and the backup taking the carries that week — which is a different
mechanism on a different timescale. `upside.ts` and `depth.ts` model that case and
their `QUEUE_CLAIM = [0.6, 0.25, 0.15]` is NOT invalidated by this finding.
Do not delete it on the strength of this result; it has simply never been tested.

**REWORKED, everywhere it appeared.** The vacancy is now reported **gross** —
netting out arrivals was refining an estimate of something that measures zero,
and `ARRIVAL_CLAIM` was doing real damage while it did so. Every surface that
asserted inheritance now states the fact and refuses the inference:
`verdict()`'s "speculative — volume open" (which also carried the *gem* tone) is
now "bench flier — volume open, but nobody is owed it"; the `volume-open` and
`lottery` tags say the measurement out loud; `contingent` is relabelled from
"next in line" to "has a branch"; the waiver wire's tier heading is now "VOLUME
HAS OPENED — nobody is owed it, and these are the men closest to it". The case
files it under **unknowns**, never as a reason either way, and an audit check
enforces that.

**The absorption bug that started this is still real and now moot.** `ARRIVAL_CLAIM`
indexes a **90-man camp roster** and SUMS claims, so Philadelphia's rookie WR2
(0.35), rookie TE2 (0.25), Wicks (0.15) and Marquise Brown (0.08) absorbed **83%**
of the vacancy A.J. Brown left, and DeVonta Smith — incumbent WR1, 24% target
share, listed first — read 7%. It erased the six biggest vacancies in the league
(MIA 53%→9%, WAS 52%→5%, PHI 43%→7%, NYG 39%→4%, TEN 35%→4%, SF 34%→3%). Bug #12
fixed one version of this and left the numbers as guesses. The right fix is not
better absorption numbers — it is to stop claiming the volume lands anywhere.

**VALUE is correctly built and answers only one question, and it stops
discriminating after round 3** (measured on 578 drafted player-seasons,
2022-2025). Spearman of draft order against what players actually returned —
and VALUE is .905 correlated with draft order, so this is VALUE's ceiling:

| band | rho(draft order, actual) | rho within position |
|---|---|---|
| rounds 1-3 | **.268** | **.339** |
| rounds 4-6 | .080 | .055 |
| rounds 7-10 | .058 | .121 |
| rounds 11+ | .217 | .238 |

The board's own note says VALUE "stops separating players after ~round 8". It
stops after round **3**. (Rounds 11+ recovering is survivorship — a player with
an ADP that late who took the field at all is a selected group.)

**Negative VALUE is a shifted origin, not a flaw.** Subtracting a per-position
constant cannot reorder anyone within that position, so the sign only does work
across positions. And it is empirically normal: of players who were actually
DRAFTED, **41% of WRs, 48% of RBs, 45% of TEs and 71% of QBs finished below
replacement**. A negative projection is the ordinary outcome for a real share of
every position, so "drafted but negative" is not a contradiction — it is the
base rate. The problem is presentational: it reads as a verdict on the player.

**A GEM with negative VALUE is likewise not a contradiction.** VALUE is an
expectation over a full season; GEM is a statement about a profile's HIT RATE
(59% against a 31% base). At pick 129 every available ticket has a negative
expectation — the question is which one hits most often, and that is a different
quantity from the mean.

**Two metrics are genuinely missing, and both are measurable from data already
ingested.**

1. **The drop to the next player at the position (VONA / tier break).** VORP
   compares a player to the FREE option; a drafter is choosing among the players
   still on the board. Mean points by within-position finish rank, 2022-2025:

   | rank | QB | RB | WR | TE |
   |---|---|---|---|---|
   | 1 | 401 | 345 | 323 | 229 |
   | 6 | 307 | 260 | 233 | 150 |
   | 12 | 272 | 215 | 199 | 119 |
   | 24 | 166 | 170 | 170 | 86 |
   | 43 | 54 | 101 | 125 | 46 |

   Read downward: QB falls off a cliff after 12, WR is nearly flat from 12 to 43.
   That shape is the scarcity, it differs enormously by position, and a single
   replacement line cannot express it. It is what answers "take the RB now or
   wait", which VALUE cannot.

2. **Week-to-week startability.** A season total hides it completely. Among RBs
   finishing between 130 and 170 points, the startable rate (top-24 that week)
   runs from **90%** (Jonathan Taylor 2023, 147 pts) to **24%** (Javonte Williams
   2024, 132 pts) — a 66-point spread at the same season total. WRs: 82% (Puka
   Nacua 2024) against 24% (Diontae Johnson 2022). In a weekly league those are
   not the same asset, and nothing on the board distinguishes them.

**Startable rate is a RESTATEMENT of points per game, not a second opinion**
(`calibrate:startable`, 1,782 season pairs, 2018-2025). Startable = finished
inside this league's starter count that week (QB12 · RB24 · WR36 · TE12), with
the bar set by that week's actual scoring rather than a fixed points total.

| | r(rate, next rate) | r(ppg, next ppg) | **rate AFTER ppg** | ppg after rate |
|---|---|---|---|---|
| WR | .680 | .762 | **−.029** | .332 |
| RB | .682 | .732 | **.056** | .223 |
| TE | .662 | .743 | **.035** | .285 |
| QB | .436 | .492 | **.142** | .095 |

It repeats well, and points per game dominates it entirely. Only **4-5%** of
players (13% of QBs) sit more than 15 points of rate away from what their
scoring level implies. So it must **never** be blended into a projection or
treated as a signal — that is the mistake `calibrate:advanced` exists to prevent.
It earns a place as a **unit**: turning "150 points" into "startable in about
48% of weeks" states the same forecast in the terms the league is played in, and
lets two positions be compared in starter slots. Labelled as a restatement
everywhere it appears; the audit checks it still tracks the projection at r≥0.9,
because a loose fit would mean it is being computed from the wrong quantity.

**#91 — the startable rate must be per SEASON WEEK, not per game played.** The
first version divided the projection by `expected_games` on the reasoning that a
rate is "of the games he plays". But `blended_points` is a season total that
already accounts for missed time, so dividing by expected games charges the
absence twice. Malik Willis came out at 223 points over 4.3 expected games — 51
points a game — and a **100% startable rate against Josh Allen's 59%**. A backup
reading as more available than Josh Allen is the tell. Both sides of the fit and
the application are now per season week, which is consistent for covered and
uncovered players alike and means the more useful thing anyway: a missed week is
a week he was not startable.

**Rejected hypotheses** (tested, did not hold):
- QB goal-line carries do *not* suppress WR TDs (**+0.125**, positive)
- Bad defence does *not* create value via shootouts (**−0.097**)
- Team motion rate does not predict (**0.022**), and nflverse motion has no
  player attribution anyway
- For WRs, target share absorbs nearly everything

---

## Key architecture decisions

- **VALUE is the draft order early and ONLY early.** Measured within position
  against what players returned: rho .518 in rounds 1-3, .207 in 4-6, **.066 in
  7-10**. UPSIDE overtakes it from round 11 (.412 v .207) and is NEGATIVE in
  rounds 7-10. See `calibrate:upside`.
- **VALUE (points over replacement) is the draft order and the default sort.**
  Slot gap is secondary — it made deep QBs look elite (Herbert +54 while
  projecting *below* replacement). VALUE yields WR 33 / RB 18 / TE 5 / QB 4 in
  the top 60, first QB at 18.
- **VALUE stops separating players after round 3, not round 8** — the old note
  here was optimistic by five rounds. UPSIDE takes over from round 11 and is
  actively harmful in between. Both are on the board, with the bands stated.
- **Per-position baseline curves**, not pooled. At pick 36 an RB returns 9 VORP
  and a WR 42.
- **Blend = 60% market / 40% usage**, in z-space within position, mapped to the
  market's scale. This was shipped as a judgment call and is **now measured**
  (`calibrate:blend`) — it costs 0.0015 of correlation against a perfectly-tuned
  weight, and the optimum is not identifiable inside [0.5, 0.9]. It governs
  **101 of 182 board rows**; 65 are usage-only (weight 0), 2 market-only, 6
  rookies at 0.85. Any argument about the weight is an argument about 55% of the
  board.
- **UPSIDE and BUST are ONE column, `OUTLOOK`** — a bust-to-breakout axis, 0-100,
  high is good. They were 87% mirror images and neither survived the other
  (partial .020 and −.051), so two columns were one measurement shown twice.
  The halves remain on the hover as explanation. See `calibrate:upside`.
- **VONA and Start % sit beside VALUE on the board**, because VALUE compares a
  player to a FREE replacement and stops discriminating after round three. VONA
  is the drop to the best player at his position expected to last to the
  drafter next turn (24 picks, a snake round-trip); Start % is the projection
  restated in weekly units. Neither is coloured on the value/reach palette —
  neither is a verdict.
- **The read is ONE verdict plus the case for and against** (`lib/pipeline/case.ts`,
  `value_scores.player_case`). This replaced the flat tag list as the primary
  surface. Tags were peers, so Matthew Golden carried **GEM and NO UPSIDE and
  "lottery ticket"** at once — three claims from three evidence bases of
  completely different quality, rendered as three identical chips. The fix is
  structural, not a precedence table: there is exactly one headline and
  everything else is evidence, and evidence is *supposed* to conflict.
  - **Every point carries its strength**: `measured` (a calibration backs it and
    the hover quotes the number), `weak` (real but |r| under ~0.15), `fact`
    (descriptive, contributes zero to the verdict), `unknown` (**measured to
    carry no direction** — vacated volume is the whole of this category).
  - The verdict weights `measured` points **double**, because a case built on
    calibrated findings must not be outvoted by a longer list of descriptive
    ones. That is precisely how GEM lost to NO UPSIDE.
  - **`value_scores.verdict` IS the case headline.** `verdict()` and `buildCase()`
    were two independent verdict systems and disagreed on **17 of 174 rows** —
    the same failure one level up. `verdict()` survives only for its tone, which
    drives the board palette.
  - **The bust chip is gated on the case tone**, so a chip can never contradict
    the headline above it. DeVonta Smith read "bust lean" under a case that
    concluded the argument cut both ways.
  - Tags still exist for board filtering, now with **mutual exclusion** (one
    price tag; an explicit `SUPERSEDES` table). 33 rows carried two price tags.
  - **Coverage is the failure mode to watch.** The first version gated every axis
    behind a cutoff and left four players — Barkley among them — with an empty
    case. Middling readings are now stated as `fact`, so every axis speaks for
    every player without distorting the verdict. A band wide enough to be safe is
    too wide to describe anyone in it: calling Barkley's 78th percentile
    "middling" was family #7 in new code.
- **A backup's expectation describes neither of his outcomes.** `upside.ts`
  re-runs the *same* fitted usage model at the share vector he would hold after
  inheriting the blocker's work, reported beside the probability rather than
  blended into it. Uses exact 2^n state enumeration over who is available — never
  "any blocker falls", which is the wrong event for anyone two deep.
- **The comparables panel is built for every player with a role, not the board.**
  `player_outlook` is its own table for exactly this reason: `value_scores`
  exists only where there is an ADP, so hanging the outlook off it gave 162
  players a panel and left ~350 with a measured role — the whole waiver wire —
  without one. `lib/pipeline/outlook.ts` holds the build so the script and the
  pages cannot drift; `value_scores.outlook` still carries a copy for the board's
  sort and is written from the same rows, never recomputed.
- **The outlook reports two scales.** A season total is the draft-day unit; points
  per game is the in-season one, because a week-8 waiver claim is decided on what
  a start is worth and a season total is that plus an injury history. Both come
  from the same neighbourhood — the audit checks they agree.
- **Distance bands are per position and travel inside the outlook.** The median
  neighbour sits at 1.36 for a WR and 1.97 for a QB, so one hard-coded cutoff
  graded 87% of quarterbacks "thin". Anything rendering a closeness label must
  use `outlook.bands`, never a literal.
- **The player page opens with a written read, not a number.** `lib/pipeline/read.ts`
  composes the model's opinion into sentences from measured quantities — no
  adjectives sprinkled on a template. It exists because the page could answer
  "what is his target share" six ways and could not answer "so what do you think
  of him" at all. It carries a **conviction** label scored from evidence quality
  (market coverage, comparable support, role certainty, durability) — how much
  the model can back the view, deliberately separate from how good the player is,
  and never coloured with the value/reach palette.
- **Negative VALUE is a supply statement and must say so where it appears.**
  48% of the board is negative, by construction: only 12 QB / 29 RB / 43 WR /
  13 TE can clear replacement and the board holds 174. **19 of 25 QBs are
  negative** because QB replacement is 296, the highest of any position — Joe
  Burrow goes negative at ADP 58. This is the definition working, and it reads as
  a verdict on the player unless explicitly explained, which the read now does
  (with different wording for undrafted players, where nobody is spending a pick).
- **VALUE carries its own derivation.** `value_scores.derivation` is an ordered
  list of every step that produced the number — market read, usage model, blend
  or scale conversion, slot shrinkage, replacement subtraction — each with the
  running total and a plain-English reason. Stored rather than recomputed on the
  page, because reproducing one player's VALUE needs the whole positional
  distribution, the fitted model and the baseline curve; an explanation computed
  from different inputs than the figure it explains is worse than none.
- **Usage contributions are centred on the positional mean, never raw.**
  `value x coefficient` is part of the fit but unreadable: age carries a negative
  weight and is never near zero, so a 24-year-old back showed "age: −118 points",
  which the intercept immediately cancels. `(value − mean) x coefficient` reads as
  "worth N points more than a typical RB" and sums to his distance from the
  average projection. Any future contribution display must do the same.
- **Role certainty reports disagreement rather than resolving it.** Depth chart,
  usage rank and availability are three independent facts; where they disagree
  the job is contested, and that is the most useful thing on the page.
- **The waiver wire switches itself on when the season starts.**
  `resolveUsageSeason()` returns `live` only when games have been played *and*
  `player_usage` has rows, so a season that kicks off before an ingest falls back
  instead of emptying. When live, opportunity switches from offseason departures
  (`buildVacancies`) to **work held by players who did not appear last week**
  (`buildAbsenceVacancies`). The two are never averaged.
- **Waiver logic lives in `lib/waiver.ts`, not the script**, so `/waiver` and
  `npm run waiver` cannot drift. Fitting the usage model scans every
  player-season (~130ms), so it is cached against a stamp of the newest
  `player_usage` / `depth_chart` / `adp_raw` write. `lib/search.ts` caches the
  same way.
- **Search spans ~1000 players**, not the 179 the ADP feed prices: drafted ∪ had
  a role last season ∪ on a current depth chart. Anything meant to find
  undrafted players must use `lib/search.ts`, never the board.
- **UI is a hand-built design system in `app/globals.css`** (tokens, 32-team
  palette in `lib/teams.ts`, position colours) plus Radix headless primitives.
  Chakra has been considered and rejected TWICE, most recently during the shell
  rebuild: every page here is a server component reading SQLite directly, and a
  Chakra component tree forces them client-side, where `better-sqlite3` cannot
  run. The data would have to be lifted into props for every page to buy a
  component library the token layer already covers. **No `title=` attributes** —
  the ~1s unstyleable delay meant explanations went unread.
- **The shell is a fixed dark icon rail plus a slim topbar.** The rail is dark in
  BOTH themes on purpose: it is chrome rather than content, so holding it
  constant gives the eye a stable left edge while everything beside it inverts.
  Its labels sit under the icons rather than in tooltips, because a destination
  you have to hover to identify is one you will misclick during a live draft.
- **Light and dark are both real, and the reader can choose.** `data-theme` on
  the root element, written by `app/ui/theme-toggle.tsx` and persisted to
  `localStorage`. The OS preference applies when nothing is stored — the CSS is
  `@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) }` plus
  `:root[data-theme='dark']`, which is two blocks with the same body because CSS
  cannot share a declaration list. **An inline script in `<head>` stamps the
  saved theme before first paint**; a theme decided inside React lands a paint
  late and flashes white on every load.
- **The board is one line per row.** Tags are capped at three chips plus a "+N"
  link to the player page. Six chips wrapped onto three lines and pushed rows
  past 100px, which turned a dense board into a list of cards; the chips are
  filters and a summary now that the case carries the verdict, so the tail
  belongs on the player page. Rows settle at 50px, twelve visible at once.
- **Verdict numbers are pills, not coloured text.** A positive and a negative are
  then separable by shape as well as hue, which matters for the ~8% of men with
  a red/green deficiency. Zebra striping was dropped for the same reason it was
  added — with sixteen numeric columns the stripes competed with the value
  palette, and a strong hover on a taller row is a better guide than an
  alternating grey.

---

## Bugs found and fixed (do not reintroduce)

Grouped by family. `#n` numbering is historical order.

### Position dispatch
- **#20** QBs had no usage model at all — `PREDICTORS` had no QB entry and the
  grading loop was `['WR','RB','TE']`. 240 QB usage rows sat unused.
- **#21** Tags used `isRb ? rushShare : targetShare`, so Bryce Young was tagged
  "depth target — 0% of team targets", true of every QB in history.
- **#26** `archetype()` had no QB branch — Kyler Murray came out a "full-time,
  secondary target".
- **#31** `opportunityFor` had no QB branch, so every QB inherited his team's
  vacated **target** share. Mahomes read "32% of targets vacated".
- **#3** Depth-chart lookups must match the player's position — `MIN(pos_rank)`
  across all listings picked Dylan Sampson's kick-return entry and hid him.

### Dead threshold
- **#12** Arrival absorption pinned **all 32 teams** at the 0.9 cap, killing the
  opportunity signal league-wide. Two causes: RB/WR/TE claims summed into one
  per-team number, and a `?? 0.05` fallback giving every camp body a claim.
- **#28** The early bust tag used an absolute `bustRate >= 0.20`; QBs run 33-40%
  as a class, so **25 of 25** cleared it and all 4 early QBs were flagged.
- **#44** Vulnerability cutoffs of 12 / 14.5 games caught 54% / 68% of the
  league — the penalty was the default state. Now 9 / 13.5.
- **#45** Usage grade as evidence of insecurity fired on 36% of graded players
  and was circular: buried → fragile → buried. Removed entirely.
- **#22** No player past ADP 60 could be flagged a bust, so the back half of the
  board carried zero risk assessment.

### Cross-position comparison
- **#23** Breakout/bust rates are not comparable across positions. Late TEs run a
  **40% median** breakout rate against 8-10% for WR/RB — the 25th percentile TE
  beats the best WR on the board. Rank within position *and* draft band.
- **#49** Comparable distance was dominated by whichever feature had the
  tightest spread. SD over all seasons (including ~100 backups near zero target
  share) collapsed that scale to 0.046, so a 6pp gap contributed **3.06** while
  rush share contributed **0.04**. Target + route share were 93% of every RB
  comparison. Now **IQR over role-holders**.

### Stale fact
- **#14** Waiver rows took team from `player_usage`, putting **112 players** on
  rosters they had left — Wicks was credited with the targets he vacated.
- **#27** `qb-backup` ("not the starter") fired on last season's snap share
  alone. It hit exactly one player and got him wrong: Malik Willis is MIA QB1.
- **#29** Role tags said "his team's targets" for the 15 players who moved.
  A.J. Brown's share was earned in Philadelphia.
- **#42** Depth-chart room shares are each man's usage on whichever team he was
  with — New Orleans totalled 172% because Etienne's 53% was Jacksonville's.
- **#48** The comparables pool was **2023-2024 only** (a season needs the
  *following* year), 183 RB seasons — so the 40 nearest was 22% of the pool. The
  page claimed "since 2018". Backfilled to 2021; go further with
  `USAGE_FROM_SEASON=2018 npm run ingest:usage`.

### Scale mismatch
- **#5** Usage scale ≠ actual scale. The usage model is regressed (90-140);
  comparing to actual-points replacement put a third of the top 100 "below
  replacement".
- **#6** Market distribution is a selected elite (RB market mean 230 over 12
  players vs usage mean 134 over 51). Never z-map usage onto it.
- **#15** Do not compute VORP from usage-model points — same mismatch.
- **#19** The board recomputed VORP in SQL and reintroduced #5: every uncovered
  player was charged ~20 phantom points, so **every negative VALUE was really
  "no betting lines"**. Alec Pierce read −19 instead of +4. `blended_vorp` is now
  stored at build time and only ever read.
- **#17** `games/17` is the wrong shrink for a season in progress; the live
  season takes `currentSeasonWeight(g)`.
- **#84** **The availability discount ran on the compressed scale.**
  `build-blend` did `usage x min(1, durability/0.88)` and only *then* stretched
  onto real points, so the multiplication and the affine map were composed the
  wrong way round. They only commute when the map's fixed point is zero, and the
  usage scale's zero is wherever the ridge intercept happens to land. Scaling a
  player down to zero games therefore left him at **−17.0** points at WR, −20.8
  at RB, −6.1 at TE and **−85.4** at QB. *That the endpoint depends on his
  position is the tell* — a discount is a statement about one player's
  availability and cannot know what position he plays. The file's own comment
  further down already said "the scale conversion happens FIRST, before anything
  else touches the number"; it did not. Fixing the order moved **44 of 179 board
  rows, every one upward** — mean +5.2 at QB, +2.9 RB, +2.3 WR, +0.7 TE, worst
  case Daniel Jones **+19.9**. The old ordering was a second, hidden injury
  penalty on top of the intended one. Audit check
  `the availability discount is a pure multiplier on the points scale`
  reproduces the multiplier from `expected_games` and negative-tests at 32
  players. Note the fixed points are computed against `projectedReplacement`, not
  the `replacement_level` table — an earlier pass used the latter and got a sign
  wrong at TE.
- **#85** **Draft capital was stretched as if it were compressed.**
  `projectRookie` returns the *median actual points* of comparable draft picks —
  already real points — but it flowed into the same `toActualScale` as the ridge
  model's output, because both were called "usage". Found while fixing #84, in
  the same expression. Moves **9 rookies** — Carnell Tate −4.7, Jordyn Tyson
  −2.7, four undrafted receivers up 1.6-2.4. The board effect is small only
  because the slot shrinkage already discards 80% of a rookie's own number
  (and 100% at RB), so it was masking a ~23-point inflation on Tate rather than
  the 4.7 that survived it. **One transform, two quantities** — the same shape as
  #67, and the reason `usageActual` now names what it holds.

### Default shown as measurement
- **#41** `vulnerabilityOf` starts at 0.25 and **681 of 948 (72%)** rendered as
  exactly that. Root cause: `depth.ts` and `role.ts` read `expected_games` from
  `value_scores` (162 players) instead of `buildRiskProfiles` (867).
- **#46** 546 of 826 skill players hold under a 5% share — no job to lose. A
  healthy WR6 read "Secure". Below 8% the answer is "no real role".
- **#40** Durability came from `player_usage.games` (games with a stat line), so
  a healthy backup looked like an injured starter. **108 players** differ by 4+.
- **#50** `COALESCE(routeShare, 0)` made a backfilled season look like a player
  who never took the field. Skip a missing feature, never zero it.

### Unlabelled / misleading display
- **#24** Every element inside the Topps card must declare `display` — it is a
  `<button>` so all children are `<span>`s, and `.topps-art` collapsed from
  296px to 24px.
- **#25** `value_scores.outlook` is a JSON blob and was rendered straight into
  the page, printing `{"n":40,"floor":55.84,...}` at the reader.
- **#43** The room rendered two bare percentages with no headers.
- **#47** Three sparklines with no axis, scale or reference — decorative by their
  own doc comment.
- **#51** The depth chart showed a static "chance he loses the job" per row, when
  what decides a pick is **direction**: is the man on top giving it up, is anyone
  below taking it.
- **#34** The board sank every row with no market read on **every** sort, so
  VALUE ran to −55 then jumped back to Josh Jacobs at +59.

### Logic that was simply wrong
- **#37** The upside model sorted blockers ascending and took `[0]` — the man
  *furthest* away — and set probability to `1 − Π(1−v)` ("any blocker falls"),
  the wrong event for anyone two deep. Sanders read 55% against a real 10%.
- **#36** Comparables match on the role a player holds *now*, so a backup's
  comps are other backups. Justice Hill was tagged NO UPSIDE while one injury
  from a 137-point season.
- **#30** Every negative VORP got the same "no path" verdict across a −161 to −1
  spread. A shortfall inside 5% of replacement is "replacement level".
- **#33** An audit check can have the bug it is hunting: `LIKE '%back%'` matches
  "quarter**back**" and reported all seven correct QB archetypes as broken.
- **#7** Opportunity must be contested — two RBs cannot both inherit the same
  work. Split by queue position (60/25/15).
- **#8** Vacated volume must net out arrivals.
- **#16** `currentSeasonWeight` was calibrated, written, and never applied — its
  only caller was a `console.log` claiming this season carried most of the
  signal while every projection ran on last season.
- **#38** Small samples do not need heavy shrinking (measured; see calibrations).
- **#39** Depth chart and usage disagree, and that gap is the signal, not noise.

### The comparables panel (one screenshot, seven bugs)
Bijan Robinson's outlook read floor 161 / median 191 / ceiling 304 with
Rhamondre Stevenson as the third-closest match, for a back who had just scored
335. Every number on the panel was wrong, and none of the causes were his.
- **#52** The similarity model had **no production term** — only shares and age.
  A 60% rush share matched a 60% rush share regardless of whether the offence
  produced 335 points or 217, so elite players drew mid-tier comps. *(Cross-position
  family in spirit: a metric compared across populations it does not describe.)*
- **#53** Shares are computed over weeks played (deliberately, bug #2), so a
  7-game season had the same share vector as a 17-game one. Christian McCaffrey's
  2021 — 109 points in 7 games — was a comparable for a 17-game workhorse.
  Availability is now a feature.
- **#54** The pool required a following-season stat line, so **every player who
  retired, was cut or missed the year was deleted** — 13% of RB and 15% of WR
  role-holding seasons. Bijan's bust rate read 2.5% against a sample with the
  disappearances removed. *(Survivorship; "default shown as measurement".)*
- **#55** A player was **his own comparable** — Bijan's own 2023 and 2024 were
  the 15th and 16th "players like him". Trivially the closest profile, and not an
  answer to the question. Costs r .677→.675 to exclude; excluded.
- **#56** `sparse` was gated on the **nearest** comp only. Bijan's nearest sat at
  1.03 (fine) while his 40th sat at 2.3, so 25 of the 40 seasons setting his
  floor and ceiling were strangers and nothing said so. Neighbourhood quality is
  now measured over the whole set and reported.
- **#57** All 40 comps voted equally, so the 40th at distance 2.3 counted as much
  as the 1st at 1.03. Now distance-weighted.
- **#58** The range bar **rescaled itself** so floor pinned left and ceiling
  pinned right — every range looked identical in width — and carried no reference
  mark, so a ceiling of 288 gave the reader no way to notice it sat below the
  player's own 331. His own number and replacement level are now on the axis.
  *(Unlabelled number.)*
- **#59** The weighted quantile returned a **sample member** rather than
  interpolating, so with a small pool every starting QB came back with a median
  of exactly 246 — one particular historical season. Found by the new audit
  check, not by eye. *(Default shown as measurement.)*
- **#60** A single distance cutoff across positions graded **87% of QBs "thin"**.
  Bands are now per position. *(Dead threshold + cross-position.)*
- **#61** The card blurb asserted "since 2018" while the pool ran 2021–2024.
  *(Stale fact.)*
- **#62** The panel was built from `value_scores JOIN adp_raw`, so it existed for
  162 drafted players and **for nobody on the waiver wire** — the population the
  tool is used on all season. Same family as #13.

An audit check written for this fixed a 42-player false positive of its own: it
compared season median ÷ per-game median against a flat 6–17.5 games, which is
invalid because those are different order statistics of a skewed distribution.
Backup QBs failed it while being entirely correct. Thresholds get measured first
— including the ones inside audit checks (see also #33).

### Explaining the numbers
- **#83** **83% of the waiver wire read "projects like pick 200".** The ADP
  baseline curve spans picks 1-200 because that is where players are drafted;
  `adpEquivalent` clamps outside it and returned the clamp like any other
  answer. 211 of 253 wire rows sat on that floor, and 7 board players have their
  slot gap measured against it. Arithmetically fine, ruinous as a claim — the
  saturation family (#6), and it was my own feature. `adpEquivalentDetail` now
  returns the clamp flag, the wire reports null, and the copy says "below
  anything the draft curve covers" instead of inventing a pick.
- **#82** The market line on the receipt showed `implied_points` while the blend
  used the **completed** figure — partial coverage is scaled up for the stat
  categories no book priced, and only the raw props were displayed. Bhayshul
  Tuten read "sportsbooks price him at 105.5" against a blend that used 157.7,
  so his panel showed 105.5 and 67.6 averaging to 137.7. **29 board players are
  partially covered.** Same family as #80 — the panel narrating a branch the
  number did not take.
  Two audit checks were written for this and BOTH were wrong before the third
  worked, which is worth remembering: (a) "a blend must land between its inputs"
  is **false** for a rank-based blend across differently centred distributions
  and flagged McCaffrey behaving correctly; (b) re-deriving z needs the build's
  exact mean and sd, and missing the sample-vs-population convention flagged 45
  correct receipts, then an off-by-one in the pool flagged 26 more. The check
  that holds compares against source values: a fully covered player's receipt
  must equal his raw props, a partial one must be at or above them.
- **#80** **Seven VALUE receipts did not add up.** The derivation gated its usage
  line on `r.usage`, which is NULL for every rookie — their projection comes from
  `projectRookie` instead — so the step that drives their number never appeared.
  Jeremiyah Love's receipt showed 121.5 going into a subtraction performed on
  220.8. The blend line had the same gate and the same hole. **An explanation
  that does not reconcile with the figure it explains is worse than none**, so
  two audit checks now enforce it: the receipt must reconcile with the stored
  number, and no step may jump without a step accounting for it.
- **#76** The **GEM tag fired on 0 of 179 players.** Two causes, both familiar.
  It gated on a raw `breakoutRate >= 0.15` — an absolute cutoff on a quantity
  whose distribution differs hugely by position, so it selected tight ends and
  quarterbacks and excluded the population it exists to find (family #3). The
  project had already built `breakoutPctile` for exactly this and two
  neighbouring tags use it correctly. Then it AND-ed that against a 25%
  opportunity requirement; each is defensible alone, together they cleared
  nobody (family #2 — firing on none is the same failure as firing on all).
- **#81** GEM meant "ADP 60+", which is the FIFTH round — where a starting tight
  end normally goes. It called Tyler Warren a gem at pick 72 for being a good TE
  at the price tight ends cost. A gem is a double-digit-round or waiver player
  who earns a role (Bucky Irving, Croskey-Merritt). Now pick 120+. And the upside
  gate was `breakoutPctile`, which fights bug #36 — comparables match the role a
  player holds NOW, so a backup's comps are backups and his breakout rate is low
  by construction. Zach Charbonnet reads 12% there with 28% of the work ahead of
  him already vacated, and he is exactly the profile. The gate is now CONTINGENT
  upside: vacated work plus what he is worth if the job opens.
- **#77** With that fixed the tag flagged Quentin Johnston at a slot gap of
  **-29** — top-quartile upside, real path to volume, and the market already
  paying 29 picks ahead of the return. A gem is something you get cheaply; the
  price has to be a discount. Added `slotGap >= -5`, plus audit pairs
  `gem/reach` and `gem/slight-reach`, which caught it immediately.
- **#78** The written read INFERRED why role certainty was low instead of reading
  the recorded reason, telling Christian McCaffrey "the depth chart and last
  season's production do not entirely agree" when he is the unambiguous RB1 and
  the only flag is age 30. `buildRoleCertainty` already records the cause; the
  read now quotes it. Inventing a cause the data does not support is worse than
  saying nothing.
- **#79** `role.ts` printed "the 2th heaviest snap share" — bug #66 again, one
  file over.
- **#75** The written read told Joe Burrow — QB1 by any reading, and hurt — that
  "the projection may be describing a job he does not hold". Low role certainty
  has two unrelated causes: a contested depth chart, and an availability record.
  Telling them as one story produces a sentence that is simply false, which is
  the kind of false that stops a reader believing the rest of the page. Now
  split: listed first plus a thin games projection reads as "the job is his, the
  number of weeks he plays it is the doubt".
- **#72** The usage contribution table printed `value × coefficient`, so a
  24-year-old back read **"age: −118.1 points"**. Arithmetically part of the fit,
  nonsense to a reader, and cancelled by the intercept a line later. Centred on
  the positional mean it becomes +2.4, which is what the fact is actually worth.
  *(Unlabelled number — a figure that is technically derived and practically a
  lie.)*
- **#73** The usage step's copy said the scale "is stretched back out two steps
  down" for **every** player, but market-covered players are never stretched —
  that step only exists on the usage-only path. Explanation text that describes a
  branch the reader is not on is the same family as a stale fact.

### In-season correctness
- **#69** `ingest:context` cached play-by-play for **30 days flat**. A completed
  season never changes, but the season being played is rewritten weekly — so from
  September the board could be running on pbp up to a month stale while appearing
  live. Now 12 hours for the current season, a year for finished ones. **Any new
  per-season ingest needs the same split**; check it before trusting an in-season
  number.

### Tag precision
- **#74** Coach findings are surfaced as three RB-only tags — `new-caller`
  (12 players), `feeds-one-back` (7), `splits-backfield` (5) — plus a head-coach
  block on the scouting panel. Deliberately RB-only: the coaching-change penalty
  is 12 points for backs, 4.5 for receivers and 0 for tight ends, and the QB
  figure is a confound. Blocking is shown on the same panel and explicitly NOT
  scored, with the reason on the tile.
- **#70** `every-down` ("never off field") used a flat `routeShare >= 0.85` for
  every position. Pass-snap share is not comparable across positions — a bell cow
  leaves the field on obvious passing downs — so it fired on **38% of WR and 42%
  of TE against 4% of RB**. It was a threshold on position, not on role
  (family #3). Now the 90th percentile *within* each position, measured over
  role-holders (WR 0.91 · TE 0.86 · RB 0.64). Quarterbacks are excluded outright:
  the median starter sits at 0.94 and the 90th percentile at 0.99, so no cutoff
  discriminates (family #2).
  A first attempt used judgment numbers (TE 0.82) and fired on 58% of tight ends
  — the same mistake being fixed. Measure the distribution, do not pick a number.
- **#71** Two different definitions of "how good is this offence" existed at once:
  the tags ranked teams by summed box-score touchdowns, the scouting panel by
  actual points from final scores. The same page could call an offence 7th and
  12th. Both now read `team_context.points_rank`.
- **New audit check**: `no role or risk tag fires at wildly different rates by
  position` — flags any non-coverage, non-price tag whose top position rate is 6x
  its bottom. Needs ≥3 hits per position to judge, because the first version
  fired on "8% of QB vs 1% of WR", which is two players against one.

### Data plumbing
- **#63** **pbp spells the Rams `LA`; every other nflverse release says `LAR`.**
  Joining team context on the raw value dropped all 32 Rams skill players in every
  season — which made Cooper Kupp's 2021 and Puka Nacua's 2025, two of the five
  WR1 seasons on record, appear to fail a filter they actually clear. Aliased at
  ingest (`LA`→`LAR`, plus `OAK`→`LV`, `SD`→`LAC` for backfills).
- **#64** The context ingest used upsert only, so fixing that alias left orphan
  `LA` rows answering queries under a team nothing joins to. Ingests now DELETE
  the season before writing it.
- **#65** The QB tile printed the *team's* EPA per dropback beside one player's
  name. Cincinnati's 2025 is mostly backup play; labelling it "Joe Burrow" made a
  season he largely missed read as a season he played badly. Now states the share
  of dropbacks he actually took. *(Unlabelled number.)*
- **#66** Hard-coded `th` printed "22th" and "81th". Trivial, except this page
  argues for its own rigour and a reader who catches that stops trusting the
  decimals.
- **#1** `number_of_pass_rushers` / `was_pressure` are populated on 100% of
  plays — use `defense_man_zone_type` as the dropback marker.
- **#2** Shares must be per-week, restricted to weeks the player appeared.
- **#4** Partial market coverage must be completed, not discarded.
- **#9** ADP ingest must DELETE the year before insert.
- **#10** 2026 draft class has provisional ids (`LOV121782`) — resolve via
  pfr_id then name index.
- **#11** Ridge, not OLS, for the usage model.
- **#13** The board universe is `value_scores JOIN adp_raw`, so search could only
  see the 179 players FFC prices. Dylan Sampson was never loaded, not hidden.
- **#18** Games floors must scale in-season or the waiver page empties in
  September.
- **#32** Mahomes genuinely has no season props — accurate about the feed.

---

## Known gaps / next steps

**Highest value first.**

1. **The weekly panel is still the weakest thing on the player page.** It shows
   consistency against replacement pace. What is actually wanted is a *rolling
   in-season projection* that updates each week from games played. The machinery
   exists (`resolveUsageSeason`, the `g/(g+1.5)` curve); the panel does not use it.
2. **Widen the comparables pool.** Currently 2021-2024. `USAGE_FROM_SEASON=2018
   npm run ingest:usage` then `npm run refresh`. Verified working — 2021/2022
   returned full route-share coverage. More seasons directly improves elite
   players, who have the fewest analogues.
3. **Implied team totals from sportsbook spreads/totals** would give a
   *forward-looking* offensive environment instead of last season's result. The
   odds endpoint returns spreads and totals for ~49 NFL events.
4. **Team offensive strength is calibrated (+0.15) but only surfaces as a tag** —
   not applied to the projection itself.
5. **Extend the "default as measurement" audit check beyond the outlook.** It now
   exists for outlook medians and support tiers (and immediately caught bug #59);
   the same check belongs on every displayed field where rows can collapse to one
   value, which is what the 72%-at-0.25 bug was.
6. **A rest-of-season comparables lookup.** The outlook now reports points per
   game and profiles from the live season, which is what a mid-season waiver
   claim needs, but the *outcome* it reports is still the following full season.
   The genuinely right question in week 8 is what comparable roles did over the
   remaining weeks of their own season. Weekly data supports it; nothing is built.
   This is the same gap as item 1 and they should be built together.
7. **Opportunity does not move the projection, only the tags.** A player whose
   starter left carries a `vacated_share` the number never sees — Bhayshul Tuten
   is projected on a 19% rookie rush share behind Etienne while 36% of that
   backfield is open. Doing this properly needs its own calibration (does vacated
   share predict next-season points after current role?), not a hand-tuned bump.
   Same shape as item 4.
8. **The waiver audit is unfinished.** Field-level degeneracy was swept and found
   the pick-equivalent clamp (#83). NOT yet audited with the same rigour:
   `lib/pipeline/opportunity.ts` (vacancy and absence maths),
   `lib/pipeline/upside.ts` (the 2^n contingency enumeration), and
   `lib/pipeline/trajectory.ts` (in-season role direction, which is untested
   because the season has not started).
9. **The hover/interaction pass is only half done.** The six headline tiles on
   the player page explain themselves via `Stat`; the comparables rows and the
   prop table do not. The depth-chart rows and the weekly bars are done (#101) —
   the weekly bars carry a real `Tip` per week and are keyboard-reachable.

---

### History: how the usage scale got unified

*Kept because the wrong diagnosis is instructive — it was written into this file
as fact for a whole session before being measured and disproved.*

**RESOLVED — the usage scale is now unified, and the earlier diagnosis was wrong.**
The recorded guess (board-slice order statistic) was measured and disproved: the
board's WR43 usage value is 107.7 against the league's 109.0, so the universe was
never the problem. Two real bugs were:

- **#67 Two scales in one expression.** The usage-only shrinkage blended
  `b.points` (regressed usage scale) toward `slotPoints` (actual-points scale),
  then measured the result against a *third* thing, `usageReplacement`. A
  regression's fitted values have spread **R × sd(actual)**, so a usage-scale
  deviation from replacement is exactly R times the real one. The dual
  replacement level fixed the intercept and left the slope wrong, which is why it
  survived until the model improved. Now `toActualScale()` converts once, up
  front, and **one replacement level serves everyone**. R comes from the stored
  fit (`usage_model_fit`), so the correction re-derives itself on every refit —
  which matters in-season, when the model changes weekly.
- **#68 A confidence term that could never reach 1.** `seasons / (seasons + 1)`
  gives a ten-season veteran 0.91, so *every* uncovered player was permanently
  hauled toward his ADP slot regardless of how much history he had — a haircut
  applied to one group and not the other. Now `min(1, seasons / 3)`. This was the
  whole of the remaining gap: recomputing those receivers without it moves their
  median VALUE from 23.7 to ~56 against 52.7 for covered.

**The audit check itself had two flaws** (see #33 — a check can have the bug it
hunts). It pooled positions, so a 9-player uncovered group containing three tight
ends was compared against 46 receivers; and it ignored availability, which is not
incidental because a book declines to price a player precisely when it does not
know if he will play (Malik Nabers: grade 94, VALUE 14.5, off an ACL). It now
compares within position among healthy players and **requires 5 per side**,
reporting "not testable" otherwise rather than judging on a median of three.

Board after the change: **WR 30 / RB 23 / TE 5 / QB 2** in the top 60, first QB at
25 (was WR 33 / RB 18 / TE 5 / QB 4, first QB at 18).

---

### Writing for the reader — the standing rule

**Plain language, everywhere a reader sees it.** Percentages, points and games
are not jargon and should stay. Statistical notation is: `r 0.42`, `partial
0.204`, `out-of-sample R² 0.58`, `n=150 v 188`, `0.34 z`, "monotone",
"indistinguishable from zero". Those belong in code comments and in this file,
not in a tooltip. Say the finding, then the magnitude in words a drafter uses —
"about 73% of the time", "roughly twice as much", "in all 4 seasons checked".

A `measured` point must still carry its number: the audit check
`every "measured" point quotes the number behind it` fails if the basis has no
digits, which is what stops the label decaying into confident-sounding
assertion. Rewriting for plainness broke that on 191 points and then 35 before
it was right — the rule is *replace the notation*, not *delete the evidence*.

### #92 — UPSIDE was a cross-position column all along

The board showed the RAW breakout rate. Sorting it returned **10 quarterbacks
and 5 tight ends in the top 20**, against a board that is 44% receivers. Not
because they have more upside: "top-12 at your position" is a fixed bar held
against pools of very different size, so the median breakout rate is **QB 35% ·
TE 36% · RB 14% · WR 7%**. A receiver clearing it is doing something five times
rarer.

Bug #23 established the rule and `ratePctile` implements it — but the fix was
applied to the tag thresholds and to the COLOUR, and never to the number or the
sort. The column now shows the rank within position and draft band
(`breakout_pctile` / `bust_pctile`, persisted from the same `ratePctile` the
tags use); the raw rate moved to the hover, where it is described rather than
compared. Top 20 is now WR 9 · RB 7 · QB 2 · TE 2.

**Audit check `sorting a board column does not just select one position`** tests
what a reader actually does — sort the column, look at the top — and fails any
column whose top 20 is more than 3x a position's share of the board. Negative
tested: the old raw column fails it at 50% QB against 14% of the board. A signal
may legitimately favour a position (backs dominate VONA because their cliff is
steepest, and that IS the finding); it may not return a top 20 that is half one
position holding a seventh of the board.

**"VALUE stops late — use UPSIDE there" is WRONG AS STATED, and right in a
narrower place than the board claimed** (`calibrate:upside`, comparables rebuilt
from scratch for each season using only seasons before it, 257 drafted
player-seasons). Spearman against actual points, **within position** — the only
version that means anything, since a drafter chooses among players at one spot:

| band | draft order | UPSIDE |
|---|---|---|
| rounds 1-3 | **.518** | .358 |
| rounds 4-6 | **.207** | .192 |
| rounds 7-10 | .066 | **−.155** |
| rounds 11+ | .207 | **.412** |

UPSIDE beats the draft order **only from round 11**, where it is twice as good.
In rounds 7-10 it is **negative** — actively misleading, worse than having no
column. And that is the same dead band where the slot gap carries r 0.04.
Something about picks 73-120 defeats every price and profile signal here; the
board now says so in both tooltips rather than sending readers there.

Pooled across positions the raw breakout rate looked *better* than the
percentile (.434 and .461 in two bands). That is an artefact: quarterbacks have
both the highest breakout rates and the highest point totals, so a pooled
correlation is largely measuring which position a player plays. **Within
position the raw rate and the percentile are the identical ordering** — any gap
between them was position, not signal. Worth remembering the next time a pooled
number looks strong.

**Two folds and a thin pool.** Usage rows run 2021-2025 and a comparable season
needs the following one played, so the pool is 2 seasons for 2024 and 3 for
2025, against the 4 that ship. That handicaps the model here. Two folds cannot
settle the question; they can show the claim does not survive contact, and it
did not.

**How BUST is calculated.** `bustRate` is the distance-weighted share of the 40
nearest historical seasons whose player then **failed to clear replacement**.
`bustPctile` ranks that within position and draft band; the board shows the rank.

**The bar was half of replacement and is now replacement itself.** The old bar
landed at a wildly different depth per position:

| | replacement | old bar (half) | which was about |
|---|---|---|---|
| QB | 296 | 148 | **QB27** and worse |
| RB | 149 | 75 | **RB54** and worse |
| TE | 119 | 59 | **TE35** and worse |
| WR | 122 | 61 | **WR90** and worse |

A receiver had to fall out of the league to "bust" while a quarterback only had
to be a backup, and the median raw rate ran 5% for early WRs against 20% for RBs
— that gap was the bar, not the risk. At replacement itself the event means the
same thing everywhere: worth less than the man available for nothing.

**It predicts better.** BUST percentile against actual points, within position,
comparables rebuilt per season (`calibrate:upside`) — negative is correct:

| band | old bar | new bar |
|---|---|---|
| rounds 1-3 | −.161 | **−.261** |
| rounds 4-6 | −.150 | **−.231** |
| rounds 7-10 | −.015 | +.111 |
| rounds 11+ | −.213 | **−.307** |

Stronger in all three bands that carry signal. Rounds 7-10 flips sign, which is
the trough where nothing works and is not evidence either way.

**The change makes `bustRate` the EXACT COMPLEMENT of `hitRate`** (`> repl`), so
they sum to one and are one measurement with two names. Written as `<= repl` so
that is exactly true, with an audit check enforcing the sum. The player page was
printing both — "52% failed to clear replacement" in the written read and "48%
cleared replacement" in the comparables panel, a few inches apart, looking like
two findings. One framing now, stated once, and it is the board column's:
**bust**.

**BUST AND UPSIDE ARE ONE MEASUREMENT SHOWN TWICE** (`calibrate:upside`, the
partial test that demoted startability). Ranked within position AND draft band,
which is how `ratePctile` works in the build:

| band | UPSIDE | BUST | UPSIDE after BUST | BUST after UPSIDE | corr |
|---|---|---|---|---|---|
| rounds 1-3 | .358 | −.367 | **.076** | **−.116** | −.884 |
| rounds 4-6 | .173 | −.190 | .034 | −.087 | −.806 |
| rounds 7-10 | −.177 | .167 | −.060 | .011 | −.921 |
| rounds 11+ | .412 | −.395 | .157 | −.092 | −.852 |
| **ALL** | .132 | −.140 | **.020** | **−.051** | **−.874** |

**Neither survives the other.** Both raw correlations are real and modest; both
partials collapse to nothing — .020 and −.051 pooled. At −0.874 correlated they
are the same axis with the sign flipped, and a reader taking "high upside" and
"low bust risk" as two reasons is counting one measurement twice.

The largest surviving partial is UPSIDE after BUST in rounds 11+ at .157 on
n=26, which is a hint and not a finding.

**COLLAPSED INTO ONE COLUMN — `OUTLOOK`.** Two columns of one measurement
invited a reader to count it as two reasons, so the board now shows a single
bust-to-breakout axis: the mean of the breakout rank and the REVERSED bust rank,
0-100, high is good, ranked within position and draft band.

Averaging rather than picking a half is measured, not assumed. Scored against
what players actually did:

| band | upside only | bust only (flipped) | **combined** |
|---|---|---|---|
| rounds 1-3 | .358 | .367 | **.373** |
| rounds 4-6 | .173 | .190 | **.191** |
| rounds 7-10 | −.177 | −.167 | −.176 |
| rounds 11+ | .412 | .395 | **.420** |
| ALL | .132 | .140 | **.140** |

The combined axis beats or ties both halves in every band that carries signal.
The gains are small (+.006 to +.015) and that is exactly what noise cancellation
between two readings of one latent quantity looks like — the reason to average
rather than pick.

Both halves survive on the hover as explanation, never as ranking. Three audit
checks hold the shape: the halves must stay near-mirrors (r ≤ −0.6, so a drifted
definition is caught), the axis must equal the average it claims to be, and
sorting it must not just select one position.

**A methodological note worth keeping.** The first version of this test ranked
across every ADP inside a position-season and sorted into bands afterwards. It
disagreed with the within-band table by a wide margin (.122 against .412 at
rounds 11+) because it was scoring late players against the whole position
rather than against the players actually available at that point. Grouping has
to match how the number is built — position AND band — or the test measures a
different quantity than the board shows.

**A percentile threshold can never say "nobody here is risky".** The bust tag
fires on `bustPctile >= 70`, which selects the worst 30% of every pool by
construction — measured, 26% early and 29% late. It is the mirror of bug #28: an
absolute cutoff fired on 100% of quarterbacks, and the fix replaced it with a
rule that fires on a fixed fraction whatever the absolute risk is. Both are
uninformative about level; only the second is uninformative *quietly*.

**Vanishing is 8-20% of the bust rate** (RB 20%, TE 15%, WR 13%, QB 8%; corr
0.46-0.85). A player who never played again scores zero, which is below any bar,
so he counts. That is deliberate (#54) and worth knowing when reading the number:
a fifth of a back's bust rate is "was not in the league", not "played badly".

### #94 — the board carried outlooks from an older schema

`build:outlook` deletes and rebuilds `player_outlook`, but only **UPDATEd**
`value_scores.outlook` for the players it produced. Anyone who dropped out of a
build — profile under the games floor, comparables gone sparse, left the league —
kept whatever was written the last time he qualified.

Chase Brown and Theo Wease were still carrying outlooks with **no `support`, no
`vanishRate`, no `bands`, no per-game figures**, and breakout and bust rates from
a model predating the production term (#52), the availability feature (#53) and
the distance weighting (#57). The board ranked them on it, because `sparse` was
false and nothing else looked wrong. Same family as #9 and #64: an upsert that
never deletes leaves orphans answering queries under a key nothing rebuilds.

The build now NULLs the whole season's copy before rewriting. Audit check
`no board row carries an outlook from an older build` tests by SHAPE rather than
timestamp — a row missing fields the current builder always writes cannot have
come from the current builder.

**The late board is two populations, and the draft order only means something
inside each** (`calibrate:lateboard`, 590 drafted player-seasons). The one
actionable finding to come out of the dead-band investigation.

The plainest form needs no statistics. Split the late board (pick 121+) in half
by ADP and compare what each half returned:

| group | earlier half | later half | difference |
|---|---|---|---|
| held a role last season | 136 | 94 | **+41** |
| did not | 117 | 103 | **+14** |
| pooled | 125 | 101 | +24 |

Taking the earlier pick is worth three times as much among proven players as
among unproven ones. Pooling them averages a real ordering with a nearly random
one.

**Where it starts helping**, swept rather than assumed (the last band edge chosen
after the fact turned out to be an artefact): −.038 from pick 61, **+.021 from
73, +.062 from 85, +.072 from 97, +.178 from 109**, +.130 from 121. It is worth
surfacing from about pick 85 and strengthens with depth.

**The definition is measured, not typed.** Splitting on "10+ games AND 80+
points" (fires on 56%) gains **+.130**. Every looser version fails:

| definition | fires on | gain |
|---|---|---|
| **10+ games AND 80+ points** | **56%** | **+.130** |
| 80+ points | 61% | +.114 |
| 12+ games AND 100+ points | 40% | +.044 |
| 10%+ of team volume | 60% | −.014 |
| 10+ games | 70% | −.024 |
| played at all | 81% | −.035 |
| 8+ games AND 60+ points | 70% | −.078 |

Everything firing on 70-81% comes out negative — dead threshold (#2), a split
that puts nearly everyone on one side separates nobody.

**It is not one season.** Dropping each season in turn: +.130 / +.302 / +.113 /
+.093. Positive in every leave-one-out.

**Shipped as a FILTER, not a re-ranking.** Two board chips, "had a role" and
"unproven", so one population can be read at a time. It does not touch VALUE —
the finding is that the two groups are not comparable, not that either is
better; they return 115 and 110 points on average, and the unproven group
actually clears replacement *more* often (30% v 23%). An audit check fails if
either side drops below 20% of the late board.

### There is no dead band. There is a trough, and it is not the board's fault.

`diagnose-deadband`, 590 drafted player-seasons. Three separate measurements had
landed on "picks 73-120", so the band went into the code as `GAP_DEAD_BAND` and
into the copy quoted to the pick. **A rolling 60-pick window says no such edge
exists.** Draft order against actual points, within position:

| window | rho | | window | rho |
|---|---|---|---|---|
| 1-60 | **.467** | | 76-135 | **.103** |
| 16-75 | .250 | | 91-150 | .108 |
| 31-90 | .196 | | 106-165 | **.263** |
| 46-105 | .149 | | 121-180 | .193 |

A smooth decay from pick one, a trough around 76-150, a partial recovery after.
The 0.041 figure was real for the band edges chosen and an artefact of choosing
them — **rounds 4-6 established players come out at 0.010, worse still**, and
which band looks deadest flips between samples.

**It is not specific to any signal.** Prior-season points — the best single fact
available before a season — traces the same curve: .262 (1-60), .085 (31-90),
recovering to .22 (91-165). The middle of the draft is the least forecastable
stretch by anything, not a place where this board's signals happen to fail.

**Five mechanical explanations, all tested and rejected:**

| hypothesis | test | verdict |
|---|---|---|
| outcome compression | within-position sd 69 / 63 / 58 / 56, CV *rises* .33→.50 | no — plenty to predict |
| censoring on playing | 89% of picks 73-120 played 10+ games, 2nd highest; only 12% of variance from that split; restricting to players who played moves rho .120→.144 | no |
| market noise | ADP stdev as a share of ADP is *lowest* at 7-10 (9%) and *highest* in rounds 1-3 (21%) | no — inverted |
| range restriction | picks are *closest together* in rounds 1-3 (2.6 apart), where the signal is strongest | no — inverted |
| mixture of populations | 7-10 subgroups .106 / .155 against .120 pooled | no for 7-10 |

**The mixture explanation IS right for rounds 11+, and that is actionable.**
There, established players rank at **.307** and unproven ones at **.345**, against
**.193** pooled. Interleaving the two costs real signal. Splitting the late board
by whether a player held a role last season is worth building.

**Draft order and price-residual have opposite profiles.** Whether prior
production predicts a player's return *relative to his slot*: .006 at picks 1-60,
rising to **.242** at 91-150. So the top of the draft is priced efficiently —
the order is right and there is no residual to find — and the bottom is not,
where the order is weak but the residual is findable. That is what an attentive
market at the top and an inattentive one at the bottom looks like, and it is the
most useful sentence in this section.

`GAP_DEAD_BAND` stays, relabelled in its own doc comment as **a chosen cut on a
smooth decline, not a measured edge**. Copy must say "the middle rounds", never
"between picks 73 and 120".

### #93 — the sparse-outlook placeholder was being ranked

`comparables.ts` returns early when a player's nearest historical analogue sits
beyond his position's no-analogue band, setting every rate to 0. Its comment said
*"the `sparse` flag is what gates display; these are never read"* — true when it
was written, false the moment UPSIDE and BUST became ranked columns.

It bit the players with the fewest analogues, which is to say the best ones:
**Puka Nacua (ADP 3), Jaxon Smith-Njigba (5) and Christian McCaffrey (6) all read
0th percentile for upside AND 0th for bust** — a placeholder rendering as "no
upside and no risk" — across **18 of 163** board rows. Family #6. Sparse rows are
now dropped at the read so every consumer sees null and renders an em dash, with
an audit check enforcing it.

**The lesson is the comment, not the zeros.** "These are never read" is a
contract with no enforcement, and it expired silently. Any placeholder that
exists because JSON cannot carry NaN needs a check, not a promise.

### The tag/case rebuild — bugs found by sweeping the board, not the example

Both players the user named were symptoms; the sweep across all 174 rows found
four more that neither exposed.

- **#86** `verdict()` and `buildCase()` were two independent verdict systems
  disagreeing on **17 of 174 rows**. Golden read "bench flier" on the board and
  "worth a late pick on profile" on his page. `verdict` is now the case headline.
- **#87** **Four players had a completely empty case** — Saquon Barkley, Jaylen
  Waddle, Jordan Addison, Tyjae Spears — and 27 of 77 receivers had nothing
  measured either way, because every axis was gated behind a cutoff. Dead
  threshold (#2) in new code. Middling readings are now `fact` points.
- **#88** Calling everything from the 25th to the 80th percentile "middling"
  put Barkley's **78th percentile** under a word meaning average. Family #7.
- **#89** The case reused `whose()` from `tags.ts`, which attributes a share to
  the roster it was EARNED on. Correct for usage, wrong for a vacancy: A.J.
  Brown read "27% of **PHI's** volume has left" while playing for New England on
  New England's number. Wrong for every player who moved. Audit check added.
- **#90** 33 rows carried two mutually exclusive price tags; `buildTags` never
  enforced what `kind` implied.

### The Yahoo league connection — availability is now a fact, not a proxy

The waiver wire decided who was available from `adp_raw`: anyone the national
market drafts is not on the wire. That is a **proxy standing in for a fact**, and
it is wrong in both directions at once — a player drafted everywhere but cut in
this league never appeared all season, and a player nobody drafts nationally but
somebody stashed in August showed as free until December. Neither error is
visible from the inside; both produce a plausible board.

`lib/pipeline/ownership.ts` replaces it. `resolveAvailability()` returns real
ownership when a drafted league is connected and the ADP proxy otherwise, and
**which one answered is carried on `WaiverMeta.availabilitySource` and stated at
the top of the page** — a fallback presented as a measurement is family #6.

- **The fallback guard is "has anyone been drafted", not "is a league connected".**
  Before the draft every roster is empty, so ownership would report all ~500
  players available: perfectly accurate, perfectly useless. Same shape as
  `resolveUsageSeason()`, which goes live only when there is data to read.
- **Absence from `yahoo_ownership` MEANS FREE.** That inverts the usual risk —
  everywhere else a missing row is a gap, here it is an assertion that you may
  add the man. So an unresolved name is stored with a null `player_id` rather
  than dropped, and exclusion runs on gsis id **and** on normalized name, so a
  resolution miss degrades to "correctly hidden" instead of "confidently wrong".
  Verified end to end: a rostered player with no id was still blocked.
- **DELETE-then-INSERT per league, never upsert.** Ownership is the exact shape
  that breaks under upsert — a dropped player has no row to update, only a row
  that should stop existing. Bugs #9 and #64 were both orphans surviving a
  refresh.
- **Rosters are fetched one team at a time.** `/league/{key}/teams/roster` returns
  all twelve in one call, with ownership implied by position in an anonymous
  tree. Twelve requests cost nothing and every player arrives attached to a team
  key that came from the URL. Ownership is the one fact here that must not be wrong.
- **League settings are read and reported, never adopted.** Roster slots and
  scoring modifiers are stored, and the ingest warns if they disagree with
  `SCORING_FORMAT`/`LEAGUE_TEAMS`. Adopting them silently would re-cut the
  replacement ranks, the baseline curve and the blend weight — all measured under
  half-PPR — without anyone deciding to.
- **The `/league` page prints every roster in full**, because the wire now hides
  players on the strength of this data and a filter whose input cannot be seen is
  a filter nobody can check.

**Auth is a paste, not a callback.** Yahoo requires an HTTPS redirect URI and
rejects a bare localhost, which normally forces ngrok or a self-signed cert. But
the authorization code lands in the address bar whether or not anything is
listening — so the registered URI can point nowhere. One consent, refresh token
to `data/yahoo-token.json`, and every later ingest trades it for an access token.

**Four of the five ownership audit checks are independent; the fifth is a
regression guard and says so.** "No rostered player is offered on the wire" reads
the same set the wire filters on, so injecting an owned player did not make it
fire — the filter removed him first. It catches a future code path that skips
ownership, which is worth having and is not evidence that ownership is right.

### #95 — the audit decided its exit code two thirds of the way up the file

`npm run audit` is wired into `refresh` and is meant to exit non-zero on failure.
The summary and `process.exitCode = 1` sat at line 1417 of a 1942-line script, so
**every check below it printed PASS or FAIL into a total already reported and an
exit code already set**. Roughly a third of the checks — the whole of THE CASE,
scarcity, and the cross-position column tests — could fail without failing the
refresh.

Nothing was actually failing, so this cost nothing yet. The lesson is the shape:
an audit that does not enforce its own later checks is **worse than a shorter
audit**, because the passing tail reads as coverage. The summary is now the last
statement in the file with a comment saying anything appended must go above it.

### #96 — `drizzle-kit push --force` dropped two columns schema.ts never declared

`build:blend` writes `breakout_pctile` and `bust_pctile` and the audit reads them,
but `lib/db/schema.ts` had never declared either — they were added to the code
during the #92 work and never to the schema. A `push --force` run while adding
the Yahoo tables synced the database *to* the schema and removed them, and the
audit died on `no such column`.

Recovered by declaring both and re-running `build:blend` + `build:outlook` (no
props refetch, so no API credits). **The bug was the drift, not the push** — the
schema had been lying about the table's shape for as long as those columns
existed. Two rules out of it: never run `drizzle-kit push --force` here, and any
column written by a build script must be declared in `schema.ts` the same day, or
the next schema operation will quietly delete it.

### #97 — the comparables panel was two different panels, and one of them was the top of the draft

Players whose nearest historical season sat past their position's `noAnalogue`
band got a comparison list and **no range**; everyone else got both. **41 of 511
players, 18 of them on the board — including Puka Nacua (ADP 2.6), Jaxon
Smith-Njigba (5.2), Christian McCaffrey (5.9) and Rashee Rice (12.4).** Four of
the twelve most expensive players in the draft, so a reader starting at the top
met the exception before the rule and read the missing chart as a missing
feature rather than as a finding.

**The suppression contradicted this file's own calibration.** The `calibrate:comparables`
entry already said, of the *other* quality axis: *"A thin neighbourhood breaks the
midpoint, not the range… do not suppress the range."* The gate that suppresses
is a different quantity (`nearestDistance` against the band, not `closeShare`)
and had never been held to that standard. `calibrate:comparables` now does it —
replicating the shipped band exactly and bucketing every backtested season
either side of it:

| pos | coverage shown | coverage SUPPRESSED | MAE shown → suppressed | n suppressed |
|---|---|---|---|---|
| QB | 0.58 | **0.83** | 86.5 → 51.7 | 8 |
| RB | 0.60 | **0.46** | 43.3 → 79.8 | 15 |
| WR | 0.62 | **0.89** | 33.8 → 39.5 | 33 |
| TE | 0.57 | **0.65** | 25.0 → 32.9 | 18 |

**Same shape, second axis: the midpoint breaks, the range does not.** Error on
the median roughly doubles at RB while interval coverage holds or runs *wide* —
0.89 at receiver against a 0.60 target, on the largest suppressed group and the
position 11 of 13 picks come from. A band covering 89% of outcomes is vague, not
misleading, and vague-but-drawn beats absent. **RB at 0.46 on 15 seasons is the
one dissent**; the group is 74 seasons total, so this is directional evidence and
the page says which half of it to trust.

**Shipped: one panel for everyone.** The range is drawn for all 511, the median
marker is dashed and labelled `median · rough` where there is no close analogue,
and the legend says read the width, not the middle — including the RB dissent and
the sample size. `sparse` keeps the two jobs it earned: it drives that warning,
and it still withholds the **rates** and the ranked percentiles, which this
measurement does not cover and which #93 was about. The written read, the Topps
card blurb and the "Comparable output" tile were all asserting "no range can be
drawn" and now quote the **spread and never the midpoint** — a page that argues
for its own rigour cannot contradict its own chart three inches up (#75, #78).

**#98 — the panel dated itself a year stale.** It was labelled with the profile
span alone, so a board built for 2026 announced **"2021–2024"** while the outcomes
it draws from run through **2025**. The pool genuinely stops at 2024 — a season
teaches nothing until the following one is played — but the label made a correct
number read as a tool that had stopped ingesting a year ago. `outcomeFromSeason`
/ `outcomeToSeason` are now carried on the outlook (derived once, not `+1` at
each call site — #71), the hint reads `2021–2024 · outcomes to 2025`, and the
panel states *why* the pool ends where it does instead of leaving the reader to
wonder.

Two audit checks, both negative-tested: `every outlook carries a drawable range,
including the ones with no close analogue` (catches a missing range **and** one
collapsed to a placeholder) and `the outlook states the seasons its outcomes come
from, one past the profiles`.

### #99 — the depth chart was an accumulation, not a snapshot

nflverse ships depth charts as dated snapshots. The ingest kept **the newest row
per (player, position)**, which sounds like "the current chart" and is not: a
player cut in August has no August row, so his July row was still the newest one
*he* had, and he stayed on the chart forever at a team that had moved on.

**610 of 3,792 rows were leftovers, 41 of them skill players** — Harrison Bryant
listed at Seattle while under contract in Houston, Mike Woods at Denver with a
status of CUT, Cam Akers on an April chart in August. Three players were listed
on **two teams at once**; the primary key is `(season, player_id, pos_abb)`, so a
stale row survives at any *other* position slot, which is why the key was never
protection.

It is not cosmetic. **The waiver page requires a depth-chart listing**, so a
departed player stayed claimable all season; the depth-chart room showed
team-mates who had left; and every consumer joining on `depth_chart` inherited
it. Same family as #9, #64 and #94 — a write path that only upserts cannot
express "this row should stop existing".

**Fixed at the ingest: newest snapshot date PER TEAM, then DELETE the season
before writing.** Per team rather than globally, because teams publish on their
own days and a global cut-off would erase whichever team had not posted that
morning. A player who moved has a row on both charts and keeps the newer; a
player who was cut appears on neither. 446,130 snapshot rows now reduce to 3,219
current entries on one date across 32 teams.

Two audit checks, negative-tested: `every depth chart is one dated snapshot per
team, not a pile of them` and `no player is on two depth charts at once`.

### #100 — the whole scouting panel was keyed on last season's team

Found from one screenshot: **Jahan Dotson, traded to Atlanta, still reading Nick
Sirianni as his play caller** — on a panel whose own copy says a coaching change
costs a running back about 12 points.

`buildScouting` joined the team environment on `player_usage.team`, which is last
season's roster. Every claim in that block is present tense — who calls the
plays, who throws him the ball, how the line blocks, how good the offence is —
and **165 players had changed teams, 31 of them on the board**: A.J. Brown
(ADP 19, scouted against Philadelphia while playing for New England), Kenneth
Walker (26), Travis Etienne (39), DJ Moore (49), Jaylen Waddle (50), Mike Evans
(60). Family #4, and the same join error as #14, #29 and #42 arriving through a
different query.

The environment is now keyed on the **current** team — position-matched depth
chart, then `latest_team`, then the usage row, the same COALESCE ladder
`lib/waiver.ts` uses for bug #14.

**NOTE WHAT IT STILL IS, because this is the part that will be misread.**
`team_context` is built from play-by-play and only reaches the last season
played, so this is his NEW team measured LAST year, before he arrived. Right
team, past tense. `Scouting.movedFrom` carries the old team so the page states
it outright — *"He arrives from PHI, so every number in this block is ATL in
2025 — the offence he is joining, measured the season before he joined it"* —
and the coach tile is labelled `HEAD COACH, ATL` rather than showing a bare name
a reader has no way to check.

Two audit checks, negative-tested by reverting the fix:
`the offence on the scouting panel is the one he currently plays for` and
`the "he arrives from" note names a team he actually left`.

### #101 — the `title=` ban was a rule with no enforcement, and had been broken three times

`app/globals.css` and this file both say **no `title=` attributes** — the native
attribute waits about a second, cannot be styled, and never appears on touch, so
on a page arguing that every number carries its explanation it is the same as no
explanation. It had crept back into three places:

- **the weekly chart** — one per bar, and a bar is ten pixels wide, so it was the
  only way to read an individual week. Now a real `Tip`, and each bar is
  focusable with a visible focus ring, so the chart is readable from the keyboard
  rather than mouse-only. The text improved in passing: *"Week 4 — 4.8 points,
  below the 7-point line"* against *"Week 4: 4.8 pts"*.
- **the depth-chart room** — a duplicate of the reason already rendered as
  visible text one column over. Deleted, nothing lost.
- **the theme toggle** — a duplicate of its own `aria-label`. Deleted; the
  `aria-label` is the accessible name and was always doing the real work.

Audit check `no native title attribute on an HTML element — explanations use Tip`
greps `app/**/*.tsx`, matching only the attribute on a **lowercase** tag, because
`<SectionHead title="..." />` is a React prop of the same name and a check that
cannot tell those apart would fire on twenty correct call sites and be switched
off within a day. Negative-tested.

### `npm run check:freshness` — how old is every fact, and what refreshes it

Written after #99 and #100, because neither was visible from inside the app:
every page rendered, every number was plausible, and the only tell was a reader
who happened to know one player had moved. **A stale fact does not announce
itself**, and this tool has sources on four different clocks — daily rosters, a
rolling ADP window, a credit-metered prop feed, and season tables frozen until
September. Nothing showed them in one place, so answering "is this current?" took
a database session.

It is a **report, not a check**: it does not fail a build and is not wired into
`refresh`. `npm run audit` asks whether the board is internally consistent; this
asks whether it is still true, which is a judgement call about what is worth
spending on and when. It names the refresh command per source and marks the props
line as costing API credits, since that is the one that should never be pulled
reflexively.

It immediately found the roster feed ten days behind the depth chart, which is
**the lag that hides a trade** — 37 skill players listing a team the chart
disagreed with. Re-running `ingest:nflverse` and `refresh:adp` (both free) took
that to 5, all undrafted fringe players. Props were left stale deliberately:
refreshing them costs credits and that is the user's call.

### #102 — the depth chart was a 90-man camp roster pretending to be a fantasy room

The room listed everyone nflverse publishes: **10 to 15 receivers a team, up to
eight backs.** A seventh running back is not an asset, not a contingency, and
not on the roster in three weeks — and his row costs the reader exactly as much
attention as the starter's.

**The cut is measured, from two independent readings that agree.** How many men
per team ever hold a real share (8%+ of the position's work), across 160
team-seasons 2021-2025 — 95th percentile **QB 4 · RB 5 · WR 6 · TE 3**. And what
a listing at each rank implies, the share of men at that rank who held a role
last season:

| rank | 1 | 2 | 3 | 4 | 5 | 6 | 7+ |
|---|---|---|---|---|---|---|---|
| QB | 97% | 69% | 34% | 9% | 0% | — | — |
| RB | 97% | 81% | 38% | 34% | 19% | 14% | — |
| WR | 97% | 94% | 66% | 28% | 25% | 16% | ≤9% |
| TE | 97% | 44% | 3% | 13% | 0% | — | — |

The cliff lands in the same place both ways, so `ROOM_DEPTH` is QB 4 · RB 5 ·
WR 6 · TE 3. Rooms went from 10-15 to **QB 3-4 · RB 4-7 · WR 6-8 · TE 2-4**.

**A rank cut alone would have been wrong**, and this is the part worth keeping.
The chart lists a drafted receiver at WR11 and **Ricky Pearsall at WR14** — deep
on a camp chart and irrelevant are not the same statement, and a tool that
conflated them would drop exactly the men whose roles are about to change. So
the cut applies only to players about whom nothing else is known, with three
escape hatches, each a recorded fact rather than a projection: he held a real
share last season, somebody is drafting him, or it is his own page.

**The share hatch needs a games floor too.** Jakobie Keeney-James read a 20%
target share off **one appearance**, Samori Toure 9% off one. That is not a small
sample of a job (which `calibrate:shrinkage` says is fine — k=0, a four-game
share predicts next season at r=0.919); it is a man who played a game. Four
games, the shortest span that work found informative.

### #103 — every arrow on the depth chart was firing on an artefact

The user's report was "some players are gaining and some losing without any real
reason". Three distinct faults, each producing a confident arrow with nothing
behind it:

1. **Two ranks over two different populations.** The rising test was
   `depthRank > usageRank` — but `depthRank` counts every man in the room while
   `usageRank` counts only those with any usage at all. In a fifteen-man camp
   room with three role-holders, the third reads depth 14 against usage rank 3
   and came out **rising, "out-produced the men listed above him"** — the men he
   out-produced having no usage whatsoever. Ricky Pearsall carried exactly that.
   Family #3 and #5.
2. **Shares compared across teams.** `volumeShare` is the share of the team he
   played for last season, which #42 already established can be a different
   roster. **Brian Thomas Jr, Jacksonville's WR1, read losing ground because
   Jakobi Meyers arrived holding a bigger share of the RAIDERS' targets.**
3. **"Directly above" meant any.** `above.find(fragile)` returns the first match
   in listing order, so a third-stringer rose because the STARTER was fragile,
   skipping the man actually in front of him. Same shape as #37 and #7.

Plus two labelling faults on top: the reason said **"produced more per game"**
about a target SHARE (family #7), and a man could slip on his own availability
without holding a job — **Brady Cook, the third quarterback, at "5.0 games a
year"**. True number, false claim. **Jaxson Dart, a starter at 81% of the snaps,
read losing ground because a career backup carried a larger conditional share.**

**Only two things move an arrow now, and both are facts about this room**: the
listing disagrees with what men on this same roster actually did, or the man
directly in front is the fragile one. A player who arrived from elsewhere is
stated as an arrival and holds — he may well take the job, but his old share is
evidence about his old team, and the honest surface for "we cannot tell" is to
say so rather than pick an arrow. Slipping counts fell **57 → 26**, and what
survives reads like football: Stevenson losing New England's RB1 listing to
Henderson (each naming the other), Kittle at 33, Nabers off four games.

**`hasRole` also had bug #40 in it.** A share is computed over the weeks a man
APPEARED (bug #2), so it says nothing about how often he appears — Aidan
O'Connell took 78% of the pass snaps in the one game he played, read as holding
a role, then as LOSING it because his games were low. A healthy backup wearing
the shape of an injured starter, one file over from where #40 was fixed.

**Five audit checks, and one of them is the lesson.** The first four —
cross-team shares, arrivals with arrows, backups slipping, camp-roster room
sizes — all PASSED when the rank-mismatch bug was injected back in, because that
artefact names no team, names no player and contradicts nothing. A check that
does not fire on the bug it was written for is worse than no check, since the
passing line reads as coverage (#95's lesson again). The one that catches it is
the general invariant: **an arrow must name a man in this room or quote a number
about himself** — the same standard as `every "measured" point quotes the number
behind it`. All five negative-tested by reverting each fix in turn.

## Where things stand right now (end of the last session)
- Board: **185 rows** after an ADP re-pull (was 179).
- Depth-chart rooms are cut to the men who can hold or take a role — **QB 3-4 ·
  RB 4-7 · WR 6-8 · TE 2-4**, down from 10-15 (#102), and every direction arrow
  names a man in the room or quotes a number (#103).
- Board: **WR 30 · RB 23 · TE 5 · QB 2** in the top 60, first QB at 23 (was 25
  before #84 — the availability fix lifted the injured quarterbacks).
- 511 players carry a comparables outlook (162 drafted, 349 not); 253 on the
  wire, 194 clearing the evidence floor. **All 511 now get a range** — the 41
  with no close analogue get it with the midpoint marked rough (#97).
- Every board row carries a **case**: one verdict, the argument for and against, each point stamped `measured` / `weak` / `fact` / `unknown`.
- `npm run audit` runs **103 checks**: 102 pass, 1 warning — and the exit code now
  actually covers all of them (#95). The warning is market coverage: the ADP
  re-pull added six board players the 10-day-old prop feed has never priced, so
  only 39% of WR/RB carry a full market read. It clears when the props are
  refreshed.
  (Count it with `grep -cE '^  (PASS|WARN|FAIL)'` — an unanchored grep for
  PASS overcounts, which is how an earlier note here said 90.)
- **`npm run check:freshness`** reports the age of every source and the command
  that refreshes it. Rosters, depth charts and ADP are current; **props are 10
  days old and cost credits to refresh**, so that call is deliberately the
  user's.
- **A Yahoo league can be connected**: `npm run yahoo:auth` then
  `npm run ingest:yahoo`. The wire then filters on real rosters instead of
  national ADP and says which source answered; `/league` prints every roster.
  Nothing is connected yet, so the wire is still on the ADP fallback at 253
  players.
- Every player page carries: a written read with a conviction label, a VALUE
  receipt that reconciles step by step, a scouting panel with per-opportunity
  indicators, a comparables panel on two scales, the depth-chart room, and the
  play-caller / offensive-line block.

### Known limitations, accepted

- Rotation depth for the OPPORTUNITY maths (RB≤2, WR≤3, TE≤1) is still judgment
  from base personnel, not backtested. A flat ≤2 returned zero receivers while 22
  backup TEs passed. Note this is a different number from `ROOM_DEPTH` (#102),
  which governs who is DISPLAYED and is measured.
- Tag thresholds are judgment; the claims inside them are calibrated.
- Archetype thresholds are hard boundaries — Gibbs reads "committee back" at
  0.548 against a 0.55 cutoff.
- RB receiving is in the usage model but rarely priced, so pass-catching backs
  rely entirely on the usage side.
- Players with no offensive depth-chart listing are invisible on the waiver page
  (it requires a listing). Reachable via search.
- The waiver wire has no bye data for undrafted players — `bye` comes from ADP.
- No sortable-by-tag ordering (clicking filters but does not reorder).
