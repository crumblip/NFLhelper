import type { ReactNode } from 'react';

export const dynamic = 'force-static';

const FORMAT = process.env.SCORING_FORMAT ?? 'half-ppr';
const TEAMS = Number(process.env.LEAGUE_TEAMS ?? 12);

/**
 * The legend, organised as a reference rather than an essay.
 *
 * The previous version was nine sections in a single scroll with no contents
 * and no ordering principle — "what is a bye week" sat next to ridge regression,
 * and nothing told a reader which number to actually use. Sections now run in
 * the order someone needs them, each opens with the one thing to take away, and
 * a contents rail makes the whole thing addressable.
 */

interface Term {
  term: string;
  plain: string;
  detail?: string;
}

const SECTIONS = [
  { id: 'start', label: 'Start here' },
  { id: 'board', label: 'Reading the draft board' },
  { id: 'wire', label: 'Reading the waiver wire' },
  { id: 'season', label: 'Using it all season' },
  { id: 'market', label: 'Where the market number comes from' },
  { id: 'usage', label: 'Where the usage number comes from' },
  { id: 'measured', label: 'What actually predicts' },
  { id: 'tags', label: 'Tags and confidence labels' },
  { id: 'limits', label: 'What this will not do' },
];

function Section({
  id,
  title,
  lead,
  keypoint,
  children,
}: {
  id: string;
  title: string;
  lead?: string;
  keypoint?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="legend-section" id={id}>
      <h2>{title}</h2>
      {keypoint && <div className="keypoint">{keypoint}</div>}
      {lead && <p className="legend-lead">{lead}</p>}
      {children}
    </section>
  );
}

function Terms({ items }: { items: Term[] }) {
  return (
    <dl style={{ margin: 0, borderTop: '1px solid var(--border)' }}>
      {items.map((t) => (
        <div key={t.term} className="entry">
          <dt>{t.term}</dt>
          <dd>
            {t.plain}
            {t.detail && <span className="detail">{t.detail}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export default function LegendPage() {
  return (
    <main className="wrap">
      <p className="crumb">
        <a href="/">← Draft board</a>
        <a href="/waiver">← Waiver wire</a>
      </p>

      <h1>What everything means</h1>
      <p className="sub">
        Written for someone who has never watched a football game. Every claim with a number behind
        it says where the number came from.
      </p>

      <div className="legend-layout">
        <nav className="legend-nav" aria-label="Contents">
          <div className="legend-nav-title">Contents</div>
          <div>
            {SECTIONS.map((s, i) => (
              <a key={s.id} href={`#${s.id}`}>
                <span className="n">{String(i + 1).padStart(2, '0')}</span>
                {s.label}
              </a>
            ))}
          </div>
        </nav>

        <div>
          {/* ---------------------------------------------------------------- */}
          <Section
            id="start"
            title="Start here"
            keypoint={
              <span>
                Two independent opinions on every player: what <strong>sportsbooks</strong> expect
                him to produce, and what his <strong>actual role on the field</strong> was. The tool
                compares both against what drafters are paying.
              </span>
            }
          >
            <p className="legend-lead">
              In fantasy football you draft real NFL players and their real statistics earn you
              points. Every player has a price — the pick you spend on him. Separately, sportsbooks
              take bets on how many yards and touchdowns each player will produce, and because real
              money rides on those numbers they are careful forecasts rather than opinions.
            </p>
            <p className="legend-lead">
              This tool converts those betting lines into a fantasy projection, compares it to the
              price drafters are paying, and adds a second opinion built from how the player was
              actually used in games. Nothing here comes from expert rankings or analyst tiers.
            </p>

            <Terms
              items={[
                {
                  term: 'Which number do I use?',
                  plain:
                    'On the draft board, VALUE. On the waiver wire, grade plus opportunity. Everything else is supporting detail.',
                  detail:
                    'VALUE answers “who is worth the most”, which is the order you should draft in. Gap vs ADP answers “who is cheap”, which is a different and secondary question — a cheap player who projects below a freely available replacement is still not worth a pick.',
                },
                {
                  term: 'Fantasy points',
                  plain: `What a player earns you. Your league is ${FORMAT}, meaning half a point per catch.`,
                  detail:
                    '1 point per 10 rushing or receiving yards · 1 point per 25 passing yards · 6 points for a rushing or receiving touchdown · 4 for a passing touchdown · 0.5 per catch · −2 for an interception or lost fumble.',
                },
                {
                  term: 'ADP (Average Draft Position)',
                  plain:
                    'The average pick number at which a player is taken across thousands of real drafts. Lower means earlier, which means more expensive.',
                  detail:
                    'An ADP of 6.6 means he typically goes roughly 7th overall. This is a record of what drafters actually did — not anyone’s opinion of who is good.',
                },
                {
                  term: 'Position',
                  plain:
                    'QB throws the ball. RB runs with it. WR and TE catch it. Only these four matter here.',
                  detail: 'Kickers and team defenses are excluded from this tool entirely.',
                },
                {
                  term: 'Bye week',
                  plain:
                    'The one week each season a player’s team does not play, and he scores nothing.',
                },
              ]}
            />
          </Section>

          {/* ---------------------------------------------------------------- */}
          <Section
            id="board"
            title="Reading the draft board"
            keypoint={
              <span>
                Sort by <strong>VALUE</strong>. It is points above the freely available player at
                that position, which is what a pick is actually worth.
              </span>
            }
            lead="The board holds the players who get drafted — the ones the ADP feed prices. Everyone else lives on the waiver wire."
          >
            <Terms
              items={[
                {
                  term: 'Replacement level',
                  plain: `What you could get for free. In a ${TEAMS}-team league roughly the 30th-best running back is always sitting unclaimed, so a player is only worth what he produces above that.`,
                  detail:
                    'Measured separately for each position, because 300 points from a quarterback and 300 from a tight end are not remotely the same asset.',
                },
                {
                  term: 'VALUE',
                  plain:
                    'Projected points minus replacement level. This is the draft order and the default sort.',
                  detail:
                    'Sorting by cheapness instead made deep quarterbacks look elite — one showed +54 picks of “value” while projecting three points below a replacement quarterback. Ranking on value over replacement produces a top sixty of 33 receivers and 18 backs with the first quarterback at eighteen, which is how the position actually gets drafted.',
                },
                {
                  term: 'Gap vs ADP',
                  plain:
                    'How many picks of value you are getting at his price. Positive means he is going later than his forecast says he should.',
                  detail:
                    '+34 means the forecast prices him like a pick-24 player while he is going at 58. Useful as a tiebreak between players of similar VALUE, misleading on its own.',
                },
                {
                  term: 'Impl pts',
                  plain:
                    'Every betting line for a player, converted into a full-season stat line and scored with your league’s rules.',
                  detail:
                    'The market’s forecast of his fantasy season as a single number. It comes only from posted odds.',
                },
                {
                  term: 'ADP equivalent',
                  plain: 'The draft slot at which this much production is historically normal.',
                },
                {
                  term: 'Expected at ADP',
                  plain:
                    'What players drafted at this exact slot have actually returned, on average, across 2018–2025.',
                  detail:
                    'Busts and season-ending injuries stay in that average on purpose — what a pick is worth has to include the times it returned nothing.',
                },
                {
                  term: 'OUTLOOK',
                  plain:
                    'How players who looked like him turned out, on one scale from bust to breakout. 0 means nearly all of them disappointed, 100 means nearly all of them hit.',
                  detail:
                    'This was two columns until it was measured. UPSIDE (the share of the 40 closest historical seasons that finished top-12) and BUST (the share worth less than a free player) are 87% mirror images, and neither adds anything once you know the other — the partial correlation of one after the other is .02 and −.05. Two columns of one measurement invite you to count it as two reasons. So they are averaged into one axis, with bust reversed so both halves face the same way, and averaging beats or ties either half in every stretch of the draft that carries signal. IMPORTANT: the underlying rates are only comparable within a position, because "top-12" is a fixed bar held against pools of very different size — 68 receivers on this board against 25 quarterbacks. The axis is therefore a rank against players at his own position going around the same time. WHERE TO USE IT: from round 11 on it is the best column here, about twice as good as the draft order at picking out who returns value. Through the middle rounds it is not worth reading, and neither is anything else — that is a fact about the middle of the draft rather than about this number.',
                },
                {
                  term: 'Closest matches',
                  plain:
                    'On a player’s own page: the real historical seasons whose role, scoring opportunity and age most resembled his, and what those players scored the season AFTER the one being matched.',
                  detail:
                    'Read a row as one sentence. “Cole Kmet · his 2023 season · 95 scored in 2024” means Kmet’s 2023 profile was the closest match to this player’s current profile, and Kmet then went on to score 95 half-PPR points in 2024. The matched season and the scored season are always one apart, which is the whole point — it is what happened next to players who looked like this. Rows are ranked most similar first and labelled very close / close / loose / distant, because the fifth match is not as informative as the first. Those bands are the quartiles of the actual distance distribution across the board, not round numbers.',
                },
                {
                  term: 'Usage / vs mkt',
                  plain:
                    'Usage is his on-field role scored 0–100 against his position. “vs mkt” is how far that sits from where the betting market ranks him.',
                  detail:
                    'A large positive means his real role is better than the lines imply — the two opinions disagree, and that disagreement is the interesting part.',
                },
              ]}
            />
          </Section>

          {/* ---------------------------------------------------------------- */}
          <Section
            id="wire"
            title="Reading the waiver wire"
            keypoint={
              <span>
                Off the board there is no price, so the question changes from{' '}
                <strong>“is he worth it”</strong> to <strong>“is a role opening for him”</strong>.
              </span>
            }
            lead="The waiver wire covers every undrafted player who had a measurable role — about a thousand players are searchable, against the 179 the draft board can see. Opportunity leads the sort, because the profile behind almost every pickup that mattered is a backup on a team whose work has moved, not a player who suddenly improved."
          >
            <Terms
              items={[
                {
                  term: 'Grade',
                  plain:
                    'His role ranked 0–100 against everyone at his position. This is the ranking number on the wire.',
                  detail:
                    'Built from target share, route share, red-zone share and goal-line share — the measures that carry into the next season. Deliberately not converted into “points above replacement”: the underlying model is regressed toward the positional average, so subtracting a replacement level measured in real points produces nonsense like −61 for a perfectly useful backup.',
                },
                {
                  term: 'Vacated / opportunity',
                  plain:
                    'The share of the work he competes for that is actually available to him. Carries for backs, targets for receivers and tight ends.',
                  detail:
                    'Before the season this is offseason departures, net of arrivals — a team that lost its lead back and signed another one has nothing available. Once games are played it switches to the share held by teammates who did not play in the most recent week. A player’s own absence is never counted as his own opportunity.',
                },
                {
                  term: 'One injury away',
                  plain:
                    'What he is worth if the man ahead of him stops playing, multiplied by the chance that happens.',
                  detail:
                    'The most important number on this page and the one a plain projection cannot show. Every undrafted player projects below replacement in his current role — that is what undrafted means — so ranking on the average sorts by how buried someone is. A backup’s outcome is not a bell curve around that average; it is a coin flip between irrelevant and league-winning, and the mean describes neither. So the usage model is re-run at the share vector he would hold after inheriting the blocker’s carries and goal-line work, and shown beside the probability rather than blended into it. Jaydon Blue reads −64 as an expectation and 156 points if Javonte Williams goes down, at a 20% chance. The chance comes from the blocker’s durability (a player who missed 4+ games misses again 73% of the time), his age past the position curve, and how well he actually played. Nothing here is a new forecast — it is the same fitted model at a different, stated input.',
                },
                {
                  term: 'Priority adds',
                  plain:
                    'A quarter or more of his position’s work has left his team, and he is inside the rotation. Nobody is owed that work — checked across more than a thousand cases, teams sign and draft replacements rather than promoting the next man up — so read this as the shortest distance to a job, not as a job.',
                },
                {
                  term: 'Rotation depth',
                  plain:
                    'How far down a depth chart a real role still exists: two deep at running back, three at receiver, one at tight end.',
                  detail:
                    'Taken from base personnel — three receivers are on the field, so a WR3 is a starter; one tight end is, so a TE2 is not. A flat “top two” cutoff looked neutral and was not: every WR1 and WR2 in the league is drafted, so it returned zero receivers while letting twenty-two backup tight ends through on an 8% target share. This is judgment, not backtested.',
                },
                {
                  term: 'Evidence floor',
                  plain:
                    'Players under 3% involvement or with too few games are hidden by default. Not a verdict that they are bad — an absence of evidence either way.',
                  detail:
                    'It catches two different things: blocking fullbacks who genuinely have no offensive role, and players with a one-game sample that is neither good nor bad. In-season the games requirement scales down, because asking for four games in week two would empty the page.',
                },
                {
                  term: 'Role shrinking',
                  plain:
                    'His snap share over the last three games is 15 points or more below his own season average. A drop candidate.',
                  detail:
                    'Appears in-season only. Measured against 2018–2025, that group scores 1.23 fewer points per game for the rest of the season.',
                },
              ]}
            />
          </Section>

          {/* ---------------------------------------------------------------- */}
          <Section
            id="season"
            title="Using it all season"
            keypoint={
              <span>
                Nothing needs reconfiguring in September. Run the weekly ingest and both pages
                switch from <strong>last season</strong> to <strong>this season</strong> on their
                own.
              </span>
            }
            lead="Two things change automatically once games are played, and both are calibrated rather than chosen."
          >
            <h3 style={{ marginTop: 'var(--s5)' }}>This season overtakes last season after two games</h3>
            <p className="legend-lead">
              How well does usage predict the rest of a season? Tested by comparing, for players N
              games in, what the prior season says against what this season says so far:
            </p>
            <div className="tablewrap" style={{ marginBottom: 'var(--s4)' }}>
              <table className="findings">
                <thead>
                  <tr>
                    <th className="l">Games played</th>
                    <th>Prior season</th>
                    <th>This season so far</th>
                    <th className="l">Which leads</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ['1 game', '0.669', '0.654', 'prior season'],
                    ['2 games', '0.659', '0.702', 'this season'],
                    ['3 games', '0.646', '0.709', 'this season'],
                    ['6 games', '0.601', '0.684', 'this season'],
                  ].map(([g, prior, now, who]) => (
                    <tr key={g}>
                      <td className="l">{g}</td>
                      <td className="r">{prior}</td>
                      <td className="r">{now}</td>
                      <td className="l muted">{who}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="legend-lead">
              So the weighting follows that curve rather than a guess: this season takes 40% of the
              usage signal after one game, 67% after three, and about 90% by mid-season. The
              remainder stays with the prior year.
            </p>

            <h3 style={{ marginTop: 'var(--s5)' }}>
              Opportunity stops meaning “who left in March” and starts meaning “who is hurt”
            </h3>
            <p className="legend-lead">
              In August the useful question is which players walked out in the offseason. By
              November that roster has been settled for months, and the volume that actually moves
              is moving because somebody is injured. So in-season, opportunity is measured as the
              share of a team’s carries or targets belonging to players who did not appear in the
              most recent week. No injury report is parsed — a player who recorded no snap did not
              play, which is the fact the report would be describing.
            </p>
          </Section>

          {/* ---------------------------------------------------------------- */}
          <Section
            id="market"
            title="Where the market number comes from"
            keypoint={
              <span>
                Sportsbook odds, converted to a fantasy total. Never a projection or a ranking.
              </span>
            }
          >
            <Terms
              items={[
                {
                  term: 'Prop / line',
                  plain:
                    'A bet offered on one player’s statistic. “Receiving yards 1250.5” means you can bet on him finishing above or below that.',
                  detail:
                    'The half-yard exists so there can never be a tie. A season-long line covers the whole year; a game line covers one game.',
                },
                {
                  term: 'Over / under price',
                  plain:
                    'The odds attached to each side. −112 means you risk $112 to win $100. The two prices reveal which side the book thinks is more likely.',
                },
                {
                  term: 'P(over), devigged',
                  plain:
                    'The market’s honest estimate of the chance a player goes over the line, after removing the bookmaker’s built-in profit margin.',
                  detail:
                    'Books price both sides slightly in their own favour so they earn either way. Stripping that out is called removing the vig. At exactly 50%, the posted line is the market’s expectation.',
                },
                {
                  term: 'Season-to-game ratio',
                  plain:
                    'When only a single-game line exists, it is multiplied by about 15.2 rather than 17.',
                  detail:
                    'A season-long line already prices in the games a player is likely to miss; a single-game line does not. The ratio is taken from the market’s own numbers where both exist.',
                },
              ]}
            />
          </Section>

          {/* ---------------------------------------------------------------- */}
          <Section
            id="usage"
            title="Where the usage number comes from"
            keypoint={
              <span>
                Counts of what happened on the field. Every metric was tested against the{' '}
                <strong>following</strong> season before being allowed in.
              </span>
            }
            lead="Shares only count the weeks a player actually appeared. Dividing his snaps by a whole season of team plays would charge him for the weeks he was injured — that once made a tight end’s route share read 39% when it was 86% in the games he played."
          >
            <Terms
              items={[
                {
                  term: 'Target share',
                  plain:
                    'Of every pass his team threw to anybody, the share aimed at him. 30% is elite.',
                  detail:
                    'The strongest single predictor for receivers and tight ends. It measures how much the offence looks for him, and it carries between seasons better than points do.',
                },
                {
                  term: 'Route share',
                  plain:
                    'Of his team’s passing plays, the share he was on the field for. 90%+ is a full-time starter.',
                  detail:
                    'Separates real starters from part-time players. A high target share on a low route share means he is efficient but rarely out there.',
                },
                {
                  term: 'Red-zone share',
                  plain:
                    'The red zone is the last 20 yards before the end zone. This is his share of his team’s plays there.',
                  detail: 'Close to the end zone means scoring chances, the biggest swing in fantasy scoring.',
                },
                {
                  term: 'Goal-line share',
                  plain: 'The same idea inside the 5-yard line, where touchdowns are actually scored.',
                  detail:
                    'For running backs this is close to a separate job. Some teams have a designated big back who gets every carry near the end zone, and that assignment persists year to year.',
                },
                {
                  term: 'Snap share',
                  plain: 'The share of his team’s offensive plays he was on the field for.',
                  detail:
                    'Used in-season to detect a role changing. It moves before the touches do — a back who takes over gets the snaps immediately, while the carries can lag a week behind game script.',
                },
                {
                  term: 'Starter share (quarterbacks)',
                  plain:
                    'The share of his team’s dropbacks he was on the field for — in practice, whether he is the starter.',
                  detail:
                    'Quarterbacks are measured on their own terms: starter share, rushing volume, red-zone and goal-line carries. Target share is excluded because it is ~0 for every quarterback who has ever played, which says nothing about any of them. Starter share is by far the strongest predictor in the quarterback model at +50 points per standard deviation. Rushing volume is the next: it is what separates a top-five finish from a twelfth on the same passing line.',
                },
                {
                  term: 'Age',
                  plain:
                    'Included because it predicts decline. Two players with identical roles are not the same bet if one is 24 and the other 37.',
                  detail:
                    'Measured, not assumed: once current role is accounted for, age still correlates with next season at −0.27 for receivers, −0.18 for backs and −0.14 for tight ends.',
                },
              ]}
            />
          </Section>

          {/* ---------------------------------------------------------------- */}
          <Section
            id="measured"
            title="What actually predicts"
            keypoint={
              <span>
                Several popular statistics were tested and dropped for predicting{' '}
                <strong>nothing</strong>. What is left is here with its correlation to the following
                season.
              </span>
            }
          >
            <div className="tablewrap" style={{ marginBottom: 'var(--s4)' }}>
              <table className="findings">
                <thead>
                  <tr>
                    <th className="l">Metric</th>
                    <th className="l">Position</th>
                    <th>r</th>
                    <th className="l">Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ['Target share', 'TE', '0.76', 'used', true],
                    ['Rush share', 'RB', '0.72', 'used', true],
                    ['Red-zone touch share', 'RB', '0.72', 'used', true],
                    ['Target share', 'WR', '0.71', 'used', true],
                    ['Goal-line share', 'RB', '0.67', 'used', true],
                    ['Route share', 'WR', '0.63', 'used', true],
                    ['Total touchdowns', 'RB', '0.63', 'beaten by red-zone chances', false],
                    ['Yards before/after contact', 'RB', '0.14', 'dropped', false],
                    ['aDOT (average target depth)', 'WR', '0.11', 'dropped', false],
                    ['Yards after catch per reception', 'WR', '0.01', 'dropped', false],
                  ].map(([metric, pos, r, verdict, good]) => (
                    <tr key={`${metric}-${pos}`}>
                      <td className="l">{metric}</td>
                      <td className="l muted">{pos}</td>
                      <td className={`r ${good ? 'good' : 'dead'}`}>{r}</td>
                      <td className="l muted">{verdict}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3>Chances, not conversions</h3>
            <p className="legend-lead">
              It would seem obvious to judge a player on touchdowns scored. A running back’s share of
              his team’s red-zone plays predicts next year at <strong>0.72</strong>; his actual
              touchdown total predicts at <strong>0.63</strong>. Touchdowns carry a lot of luck — a
              ball bouncing the right way — while <em>who the coach hands the ball to near the end
              zone</em> is a deliberate decision that repeats. So the tool measures the opportunity,
              not the result.
            </p>

            <h3>A breakout is treated cautiously</h3>
            <p className="legend-lead">
              After accounting for a player’s current role, the year-over-year change correlates with
              next season at <strong>−0.24</strong> for receiver route share. A player who just
              gained ground tends to give some of it back, so there is no “trending up” bonus
              anywhere in this tool. The last three seasons are blended instead, and short seasons
              count for less than full ones.
            </p>

            <h3>Chasing a snap-share spike does not work</h3>
            <p className="legend-lead">
              The standard in-season waiver instinct is to grab whoever’s snap count just jumped.
              Tested across 2018–2025, it does not survive. Players whose recent snap share sat 15
              points or more <em>above</em> their season average went on to score{' '}
              <strong>6.77</strong> points per game — against <strong>6.84</strong> for players
              whose role was flat. No edge at all, and their predictability collapses to r = 0.25. A
              snap spike is usually somebody else’s one-week absence, and it reverts.
            </p>
            <p className="legend-lead">
              The mirror image is real. Players whose recent snap share sat 15 points or more{' '}
              <em>below</em> their season average scored <strong>5.62</strong> — a genuine loss of{' '}
              <strong>1.23</strong> points per game. That is why the wire flags a shrinking role and
              deliberately does not flag a growing one. Symmetry would look tidier and be wrong.
            </p>

            <h3>Other things that were tested and did not hold</h3>
            <p className="legend-lead">
              A quarterback taking goal-line carries does not suppress his receivers’ touchdowns
              (+0.125, the wrong direction). A bad defence does not create fantasy value through
              shootouts (−0.097). Team motion rate does not predict (0.022). Durability, by
              contrast, is highly repeatable: a receiver who missed four or more games misses again{' '}
              <strong>73%</strong> of the time, against 41% for one who stayed healthy.
            </p>
          </Section>

          {/* ---------------------------------------------------------------- */}
          <Section
            id="tags"
            title="Tags and confidence labels"
            keypoint={
              <span>
                The read is a set of tags rather than one verdict. Hover any tag for the claim behind
                it; click to filter the board.
              </span>
            }
            lead="A single label made a third of the board “fairly priced”, which is the absence of an opinion. Tags let several true things be said about the same player at once."
          >
            <Terms
              items={[
                {
                  term: 'gem',
                  plain:
                    'Late ADP, ascending, a real breakout rate for his profile, and volume open ahead of him. All four required.',
                },
                {
                  term: 'bust risk',
                  plain:
                    'Early ADP plus a reason that survives the player being good. Touchdown regression alone does not qualify.',
                },
                {
                  term: 'volume vacated',
                  plain: '30% or more of the work he competes for has left the roster unclaimed.',
                },
                {
                  term: 'startable upside / NO UPSIDE',
                  plain:
                    'Late picks, ranked against others at the same position going at the same stage of the draft. Top quarter for upside, or bottom fifth with a high failure rate.',
                  detail:
                    'Deliberately position-relative. An absolute cutoff returns a list of tight ends and calls it upside, because the best receiver on the board scores below the worst tight end on this measure.',
                },
                {
                  term: 'promoted since last season',
                  plain:
                    'His team lists him at least two places higher at his position than he ranked in their pecking order last season.',
                  detail:
                    'The projection runs on usage, which cannot see a player whose job changed in the offseason. This flags the gap rather than closing it: there are no historical depth charts in this database, so how much a promotion is worth cannot be measured, and an invented multiplier would be a guess dressed as a number.',
                },
                {
                  term: 'market / % covered / no props',
                  plain:
                    'How much of his projection came from posted season lines. “% covered” players are missing a category the market prices for their position, so their total is a floor and they are excluded from ranking.',
                  detail:
                    'Most commonly a running back with no receiving line — worth roughly 77 points, so including him would unfairly rank him last. No projection is invented to fill a gap; a blank is more useful than a fabricated number.',
                },
                {
                  term: '+n wk1',
                  plain:
                    'Part of the forecast was scaled up from a single Week 1 line, which carries matchup noise a season line does not.',
                },
                {
                  term: 'derived',
                  plain:
                    'Converted from a different betting line. No book posts season catch totals, so catches come from the receiving-yards line and his yards per catch.',
                },
                {
                  term: '⚠ selection',
                  plain:
                    'A warning on quarterbacks taken late — their gaps look larger than they are.',
                  detail:
                    'Books only price quarterbacks expected to start, but the historical comparison includes every quarterback drafted at that slot, many of whom never played. Tested against eight seasons, the tight-end signal held up and this one did not.',
                },
              ]}
            />
          </Section>

          {/* ---------------------------------------------------------------- */}
          <Section
            id="limits"
            title="What this will not do"
            keypoint={
              <span>
                Every number traces to a posted betting line, a count of what happened on the field,
                or what draft picks have historically returned.
              </span>
            }
          >
            <p className="legend-lead">
              There are no expert rankings, analyst tiers or pundit opinions anywhere in this tool.
              Where the data does not support an answer it says so rather than filling the space.
            </p>
            <h3>Missing data is not a bad verdict</h3>
            <p className="legend-lead">
              A player with no betting lines is judged on usage alone, and that projection lives on a
              different scale — the model regresses toward the positional average, so its numbers run
              about twenty points below real points. It is therefore compared against replacement
              measured on <em>that same scale</em>, not against the real-points figure. Getting this
              wrong charged every uncovered player roughly twenty phantom points and made &ldquo;no
              sportsbook prices him&rdquo; look identical to &ldquo;he is not good&rdquo;. If you see
              a negative VALUE, it should be because the evidence says so, not because the evidence
              is missing.
            </p>

            <p className="legend-lead">
              Four limits worth carrying with you. Only about <strong>69%</strong> of the board has
              season-long betting lines at all. The usage side cannot be proven to add information
              the betting market does not already have — testing that would need a historical archive
              of betting lines that does not exist publicly, which is exactly why the two views are
              shown side by side rather than merged into one number that would imply more certainty
              than there is. The <strong>60/40 market-to-usage split</strong> is a judgment call for
              the same reason. And the thresholds that trigger tags are judgment too — the claims
              inside them are calibrated, the cutoffs that fire them are not.
            </p>
          </Section>
        </div>
      </div>
    </main>
  );
}
