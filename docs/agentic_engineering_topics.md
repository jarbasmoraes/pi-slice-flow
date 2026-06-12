# Agentic Engineering Topics

References:
* top_1_opportunity_for_senior_engineers_agentic_engineering
* i_ranked_cloudflares_software_factory_and_wow_s_tier_tokenomics
* master_all_6_claude_code_dynamic_workflows

## Prompt Engineering:
**What is it**: Prompt engineering is the craft of telling an agent exactly what you want, in language it cannot misread. You state what to do, what not to do, and what good output looks like. Cloudflare learned this the hard way: they shoved a diff into a half-baked prompt, asked for bugs, and got noise, hallucinated syntax, and advice to "consider adding error handling." A good prompt is the opposite of that. It is specific, bounded, and testable.

**Why it is important**: Two engineers using the same agent and the same 200k tokens get massively different results, and the prompt is the first place that gap opens. A vague prompt buys you vague work, and vague work costs real money in wasted tokens and review time. A precise prompt buys you on-spec results. The prompt is the cheapest lever you have, because changing words costs nothing and changing outcomes costs everything.

**How does it improve Agentic Engineering**: Agents are literal. They do what the prompt says, not what you meant. Strong prompt engineering turns an agent from a chatty assistant into a reliable worker: Cloudflare prompts each reviewer agent with what to flag, what to ignore, and what format to return, and the result is real bugs caught at one dollar per merge request. Without that precision, every other layer of the system inherits the sloppiness.

**How does it fit in a development workflow**: Prompts stop being throwaway text and become versioned assets. You write them once, test them, refine them, and store them in skills, slash commands, and agent definitions. Cloudflare goes further and injects prompt context dynamically through plugins, so the prompt adapts to each review. In practice, you treat your prompts the way you treat code: review them, improve them, and reuse them across every run.

## Context Engineering:
**What is it**: Context engineering is the discipline of deciding what an agent sees. A context window is short-term memory, and it is finite. Fill it with junk and the agent forgets the goal. Context engineering means feeding each agent only what it needs: a diff patch instead of a whole repository, a clean folder instead of a tangle of files, a fresh window instead of a 600,000-token conversation.

**Why it is important**: Long sessions decay in predictable ways. The agent gets lazy and finishes seven of fifteen tasks. It drifts from the original goal after compactions and summaries wash away the details. It starts grading its own work kindly. All three failures trace back to a polluted context. Manage the context and the failures shrink. Ignore it and no model upgrade will save you.

**How does it improve Agentic Engineering**: The working rule is reduce and delegate. Reduce what each agent reads, and delegate the rest to other agents with their own clean windows. Cloudflare conserves context by passing diff patch files to specialized reviewers instead of dumping the codebase on one generalist. Dynamic workflows do the same thing: each sub-agent gets its own window so files never cross-contaminate. The result is sharper output from fewer tokens.

**How does it fit in a development workflow**: You design context the way you design interfaces: deliberately and per task. Before launching an agent, you ask what is the minimum it must see to do this job well. You structure repos, breadcrumb files, and handoff documents so agents can load the right slice fast. Fan-out patterns give each worker its own clean context, then a synthesis step merges results. Context becomes a budget you spend on purpose.

## Multi-Agent Orchestration:
**What is it**: Multi-agent orchestration is the coordination of several agents toward one outcome. One agent plays coordinator: it dispatches work to specialists, collects their findings, dedupes them, judges them, and posts a single answer. Cloudflare runs up to seven reviewer agents under one coordinator. The Pi harness pushes further with three tiers: an orchestrator, team leads, and workers talking in a chat-room interface.

**Why it is important**: One agent with a giant generic prompt hits a ceiling fast. Complex work has too many angles for a single context window to hold. Orchestration splits the problem along its natural seams, runs the pieces in parallel, and reassembles them. It is how you get past the limits of one model in one window, and it is impossible with an out-of-the-box harness you merely rent.

**How does it improve Agentic Engineering**: Orchestration is what turns a tool into a factory. Patterns like classify and act, fan out and synthesize, and tournament brackets all rest on it. Each agent stays small, focused, and honest, while the orchestrator holds the running order. Cloudflare's coordinator merges seven streams of findings into one structured review comment, which is something no single agent could produce as cleanly or as cheaply.

**How does it fit in a development workflow**: It enters wherever work fans out: code review across concerns, due diligence across folders, research across angles. You define the team once, in agent definitions and a coordinator prompt, then trigger it from CI or a slash command. The engineer stops prompting individual steps and starts designing the team. Your job shifts from doing the work to deciding who does what.

## Spend to Learn:
**What is it**: Spend to learn is the deliberate burning of tokens to discover what works. You run experiments that may produce nothing shippable, because what they actually produce is knowledge: which patterns hold, which prompts fail, which harness designs pay off. Building a new agent harness every day is spend to learn taken to its logical extreme.

**Why it is important**: Agentic engineering is a new skill, and every engineer carries learning debt against it. The only way to pay it down is reps, and reps cost tokens. Optimizing for cost too early freezes you at your current skill level. Cloudflare got dinged a C tier for exactly this: their system is so tuned for one dollar per review that they leave little room to discover the next improvement.

**How does it improve Agentic Engineering**: The engineers pulling ahead are not the ones spending the least. They are the ones who spent early, found which tokens generate value, and now compound that knowledge weekly. Spend to learn front-loads the cost of mastery. You waste tokens on dead ends now so that later every token you spend lands. It is the tuition for the widening gap between the top two percent and everyone else.

**How does it fit in a development workflow**: You carve out budget and time for experiments that have no ticket attached. Try a new orchestration pattern on a Friday. Rebuild a workflow with a different model tier. Run a tournament on a problem you already solved, just to compare. Then fold what survives back into your skills and harnesses. Move slow now to move fast later: the experiments of this month become the factory of the next.

## Human Out The Loop:
**What is it**: Human out the loop means removing yourself from steps that no longer need you. Instead of reading every diff, you let an agent review it and only step in when it flags something serious. The end state has a name: zero touch engineering, where one prompt goes all the way to production because the system is trusted enough that you do not have to look.

**Why it is important**: The human is the bottleneck. Cloudflare's framing is blunt: a merge request sits in a queue, a reviewer context-switches hours later, nitpicks fly back and forth, and the author bleeds context the whole time. Every loop that requires a human runs at human speed. Every loop that does not runs at agentic speed, which is tens to thousands of times faster.

**How does it improve Agentic Engineering**: It forces you to build verification into the system instead of into your eyeballs. Adversarial verifiers, rubrics, hard blocks on security findings: these exist so the system can be trusted without supervision. The difference from vibe coding is the whole point. You are not skipping the review because you stopped caring. You are skipping it because you engineered a system that reviews better than you do at 2 a.m.

**How does it fit in a development workflow**: You remove yourself gradually, loop by loop. First the agent reviews and you read everything. Then it approves clean code and you read only flags. Then it hard-blocks real problems and merges the rest. Each step is earned by evidence that the system catches what you would catch. Phase two is building that trust. Phase three, zero touch, is spending it.

## Agent Specialization:
**What is it**: Agent specialization is giving each agent one job and the prompt, tools, and context to do that job extraordinarily well. Cloudflare runs separate agents for security, performance, code quality, documentation, release management, and codex compliance. The same idea scales to domains: a DevOps harness, a testing harness, a billing harness. One thing, done well.

**Why it is important**: Many specialized agents always beat one generalist. This holds in every industry and it holds for agents. A generalist with a massive prompt produces vague advice; a specialist with a narrow charter produces findings you can act on. Specialization is also the moat: if your agents fit your product and your problems better than an out-of-the-box agent fits them, you win.

**How does it improve Agentic Engineering**: Specialization sharpens both output and economics. A security agent does not waste tokens pondering documentation style, so its context stays small and its findings stay precise. It also makes systems composable: you add a new concern by adding a new specialist, not by bloating an existing prompt. Cloudflare jumped to a B tier on this alone, because the role definitions were doing real work.

**How does it fit in a development workflow**: You catalog the recurring jobs in your delivery pipeline, then build a specialist for each. Each one gets its own prompt, its own rubric, its own tool access. Orchestration stitches them together. Over time your repo grows a roster: reviewer agents, test agents, migration agents. New projects start by picking a team from the roster instead of starting from a blank prompt.

## Custom Tools:
**What is it**: Custom tools are capabilities you build for your agents: CLI commands, scripts, API wrappers, and functions that let an agent act on your systems directly. Agents only command what they can programmatically reach. A custom tool extends that reach into your product, your data, and your infrastructure, in exactly the shape your work demands.

**Why it is important**: Without the right tool, an agent improvises, and improvisation burns tokens. That is the token tax: everything your agent does the long way because you never gave it direct access. A purpose-built tool replaces a hundred fumbling steps with one call. The upfront investment in tooling is what separates agents that act from agents that merely describe.

**How does it improve Agentic Engineering**: Tools are where agents stop talking and start doing. Deterministic code handles what code does best, and the agent handles judgment. Cloudflare kept only one custom tool in their review system and got marked down for it, because richer tooling would have pulled more logic out of prompts and into reliable code. The lesson runs both ways: tools are leverage, and missing tools are drag.

**How does it fit in a development workflow**: You audit what your agents do slowly or badly, then write tools to close those gaps. Expose your CLIs and APIs everywhere: codebases, products, devices. Lock down the dangerous parts so no agent can nuke production. Each tool joins your harness as a composable unit, and every workflow built afterward inherits it. Tooling becomes a standing line item, not an afterthought.

## Agent + Code Pipeline System:
**What is it**: An agent plus code pipeline interleaves deterministic code with agent judgment. Code handles the trigger, the routing, the retries, the barriers; agents handle the reading, the reasoning, the writing. Cloudflare's CI-native orchestration is the model: CI kicks off the run, a plugin architecture composes the configuration, and agents do the review inside that scaffolding.

**Why it is important**: Agents are powerful and unreliable; code is reliable and rigid. A pipeline takes the best of each. You do not want a language model deciding whether to retry a failed step, and you do not want a bash script judging code quality. Putting each kind of work in the right layer is what makes a system you can run 130,000 times a month without babysitting it.

**How does it improve Agentic Engineering**: It is the skeleton of every serious pattern. In dynamic workflows, a deterministic loop holds the tournament bracket while comparison agents fight each match; only the running order stays in context. Cloudflare's coordinator posts one structured comment because code enforces the structure. The pipeline turns clever one-off agent tricks into repeatable, on-spec production behavior.

**How does it fit in a development workflow**: You wire agents into the systems you already trust: CI triggers a review, a webhook triggers a triage, a cron job triggers a report. Workflows save down to plain JavaScript files that sit next to a skill file in a folder, shareable like any other code. The pipeline lives in version control, gets reviewed like code, and improves like code, because it is code.

## System Resilience:
**What is it**: System resilience is an agentic system's ability to absorb failure and keep going. Agents time out, models flake, outputs come back malformed. A resilient system reruns within sensible bounds, falls back to another model, isolates failures to one agent's context, and degrades gracefully instead of collapsing. Cloudflare's review factory simply keeps rerunning, inside guardrails, until it lands.

**Why it is important**: A system that needs a human every time something hiccups is not a factory; it is a demo. Failure is constant at scale: across 130,000 reviews, something breaks every hour. Resilience is what lets you trust the system enough to stop watching it, and trust is the entire currency of this phase of agentic engineering.

**How does it improve Agentic Engineering**: Resilience converts unreliable parts into a reliable whole. Loop-until-done patterns embody it: keep forming theories, keep testing them in isolated worktrees, no fixed pass count, stop only when the goal is met. Model fallbacks, bounded retries, and clean-context isolation mean one bad run costs you one run, not the pipeline. Without resilience, always-on agents are just always-failing agents.

**How does it fit in a development workflow**: You design for failure from the first prompt. Every agent step gets a retry policy and a bound. Every output gets validated by code before the next stage consumes it. Damage control wraps the dangerous tools. Failures get logged into your observability layer so patterns surface. The test is simple: can this run overnight, fail four times, and still hand you a result in the morning?

## Harness Engineering:
**What is it**: Harness engineering is owning and customizing the environment your agents live in, instead of renting a closed one. Claude Code, Codex, and OpenCode are great starts and terrible places to finish. A harness you own lets you compose your own stack: multi-agent teams, sandboxes, sub-agent delegation, model routing, agent networks, anything the work demands.

**Why it is important**: Whoever controls the agent harness controls your results. The agent is everything, and the agent lives in the harness, so renting the harness means renting your ceiling. Cloudflare hit limits with off-the-shelf review tools precisely because those tools could not flex to an organization of their size. Your tools shape what you believe is possible.

**How does it improve Agentic Engineering**: An owned harness makes specialization possible. You can build domain harnesses that do one thing extraordinarily well, stack composable customizations, and route models per task. Building one harness a day sounds absurd until you realize a software factory builds them for you. The harness is where every other pillar, from custom tools to orchestration, gets bolted in.

**How does it fit in a development workflow**: You start with a default harness and extend it slice by slice: a skill here, an extension there, an agent network when you need one. One tool, many versions: the same base harness specializes into a review harness, a testing harness, a deploy harness. Each project gets the variant that fits, and improvements to the base flow into every variant.

## Tokenomics:
**What is it**: Tokenomics is the skill of using tokens, generating value, and capturing more value than the tokens cost. Three steps: spend tokens, create something worth money, collect the money. Cloudflare is the benchmark: one dollar per merge request reviewed by a team of agents, against an engineer-hour that costs vastly more. That spread is token arbitrage.

**Why it is important**: Tokens are not free, and most token spend creates nothing. A million agent cron jobs are running right now and ninety percent are dead weight, burning cash. Tokenomics is what separates an expensive toy from a profitable factory. If you generate and capture more value per token than the next engineer, you are simply ahead, by arithmetic.

**How does it improve Agentic Engineering**: It gives every architectural choice a unit economy. Specialized agents on cheap models beat a generalist on a frontier model for most work, which is why model tiers matter. It also imposes honest tension: tokenomics pulls against spend-to-learn and against always-on agents, and the craft is balancing them. You spend freely to learn, then ruthlessly to operate.

**How does it fit in a development workflow**: You instrument cost per outcome: per review, per ticket, per report. You set token budgets on workflows, route routine work to standard or lightweight model tiers, and reserve frontier models for the bleeding edge. Before turning anything always-on, you prove its arbitrage. The question on every pipeline becomes the Cloudflare question: what does one unit of value cost?

## Model Flexibility:
**What is it**: Model flexibility is the ability to swap and route models without rebuilding your system. Cloudflare runs a three-tier scheme: lightweight, standard, and state-of-the-art, with each task routed to the cheapest tier that does the job. Owning the harness is what makes this possible; a rented harness picks your model for you.

**Why it is important**: Models matter less and less. For eighty or ninety percent of daily work, what matters is the system around the agent, not which frontier model sits inside it. New models drop constantly, and yesterday's frontier becomes today's standard tier. A system welded to one model ages badly; a flexible one gets faster and cheaper with every release.

**How does it improve Agentic Engineering**: Flexibility compounds tokenomics. Routine classification runs on a lightweight model, synthesis on standard, and only the hardest judgment calls reach the expensive tier. It also de-risks: model fallbacks keep the pipeline alive when a provider stumbles, and you can test a freshly released model on your network the day it drops, next to the agents already working.

**How does it fit in a development workflow**: You define model tiers once in your harness, then tag each agent and workflow step with a tier instead of a model name. New model releases become configuration changes, not migrations. You benchmark tiers against your own evals, promote and demote models as prices and capabilities shift, and let the routing layer quietly capture the savings.

## Extensible Factory:
**What is it**: An extensible factory is a software factory built to grow without surgery. Cloudflare's version rests on a composable plugin architecture: the entry point delegates everything to plugins that stack together to define how a review runs. Adding a capability means adding a plugin, not rewriting the core. Extensibility is built into the fabric, not bolted on.

**Why it is important**: Requirements never stop moving. A factory that handles only today's cases gets abandoned the first time tomorrow looks different. Extensibility is also the difference between building features and building factories: the factory's value is everything it will produce later, and that depends entirely on how cheaply it accepts new instructions.

**How does it improve Agentic Engineering**: It makes the factory itself a compounding asset. Each plugin, skill, or composable slice you add multiplies what every future run can do. Whatever you teach your agents once, you tap into over and over. The same principle applies to your products: make them extensible by nature, so agents can extend them too.

**How does it fit in a development workflow**: You design the seams first: plugin interfaces, skill folders, configuration that composes. New requirements become new units that snap in. Teams share these units the way they share libraries; a workflow folder with a skill file and a JavaScript file travels anywhere. Over months, the factory accumulates capability while the core barely changes, which is exactly the point.

## Always On Agents:
**What is it**: Always on agents are systems that run without you: cron-triggered, webhook-triggered, CI-triggered, working while you sleep. AFK agents, in short. They sit at the top of the maturity curve: you build the system, prove its value, and then turn it on around the clock to extract the maximum from it.

**Why it is important**: A system that only runs when you press the button is capped by your attention. Always on removes the cap and is the road to zero touch engineering: if your agents are always operating and always producing, you are at the highest level of the game. But the order matters. A million agent cron jobs are burning tokens right now for nothing, because they went always-on before proving value.

**How does it improve Agentic Engineering**: It converts proven workflows into standing capacity. The review that worked on demand now greets every merge request in minutes. The radar that ran when you remembered now runs every morning. Always on also raises the bar on everything beneath it: a system cannot run unattended unless its resilience, verification, and tokenomics already hold.

**How does it fit in a development workflow**: You earn it in stages. First the workflow runs on a slash command and you watch it. Then CI triggers it and you spot-check. Only after the arbitrage is proven does it become a scheduled, unattended job. Cloudflare deliberately stayed at "on when needed" rather than always-on, trading ubiquity for cost. That trade-off is yours to make, system by system.

**(Note: like spend-to-learn, always-on sits in tension with tokenomics. Run nothing 24/7 that you have not proven valuable on demand.)**

## Agent Observability:
**What is it**: Agent observability is visibility into what your agents actually did: which prompts ran, what they cost, what they found, where they failed. Cloudflare uses Braintrust to pull every stat that matters out of their review factory, earning a solid A. Without it, an agentic system is a black box you can only judge by vibes.

**Why it is important**: You cannot improve what you cannot see, and you definitely cannot trust it. Agent failures are quiet: a lazy run, a drifted goal, a hallucinated finding. Observability is how those surface as data instead of production incidents. It is also the foundation of tokenomics, because you cannot arbitrage tokens you are not measuring.

**How does it improve Agentic Engineering**: It closes the loop between running agents and improving them. Traces show which specialist produces noise, which prompt version cut false positives, which model tier is overkill for a task. Every pattern in the playbook, from adversarial verification to tournaments, gets better when its outcomes are logged, compared, and fed back into the next iteration.

**How does it fit in a development workflow**: You instrument from day one: traces on every agent call, costs per run, outcomes per workflow, all flowing into a tool like Braintrust or Langfuse. Dashboards answer the operating questions: what did this cost, what did it catch, what did it miss. Reviews of agent performance join code reviews as routine practice. The factory gets gauges, like any factory should.

## Self-Improving System:
**What is it**: A self-improving system uses its own outputs to make itself better. Instead of an engineer updating prompts and rubrics by hand, the system mines its own runs, finds its weaknesses, and feeds fixes back in. Cloudflare's factory is not self-improving; they update it manually, which is fine but marks the frontier they have not crossed.

**Why it is important**: Hand-tuning does not scale past a certain system size. A factory running 130,000 reviews a month produces more learning signal than any engineer can read. Self-improvement is what makes the advantage compound on its own: the system that gets better while you sleep eventually laps the system that waits for your attention.

**How does it improve Agentic Engineering**: It is the recursive form of building the system that builds the system. A loop-until-done workflow can crawl your own session logs and assemble a non-duplicative list of everything you could do better. Point the same machinery at prompts, rubrics, and routing rules, and the factory begins manufacturing its own upgrades. This is advanced-pattern territory, and that is exactly why it is the moat.

**How does it fit in a development workflow**: You start with the raw material: observability data and saved sessions. Then you schedule reflection workflows that audit recent runs, propose prompt and rubric changes, and open them as reviewable diffs. A human approves at first; the approval loosens as trust builds. Improvement stops being a quarterly cleanup and becomes a background process of the system itself.

## Developer Experience:
**What is it**: Developer experience is how the factory feels to the humans who use it. It is the engineer opening a merge request and getting one clean, structured, deduped review comment in minutes instead of seven overlapping bot rants hours later. It is triggers that fit existing habits: CI, a slash command, a familiar interface.

**Why it is important**: A factory nobody enjoys using is a factory nobody uses. The original problem Cloudflare attacked was itself a DX problem: queues, context switches, hours of waiting, nitpick ping-pong. If the agentic replacement is noisy or clumsy, engineers route around it and you are back to the bottleneck, except now you are also paying for tokens.

**How does it improve Agentic Engineering**: Good DX is what lets agentic systems spread through a team. Workflows shareable as a simple folder, skills that compose, results that arrive where engineers already work: these lower the cost of adoption to nearly zero. The coordinator agent that merges seven findings into one comment is a DX decision as much as an architectural one, and it is why people read the reviews.

**How does it fit in a development workflow**: You treat your teammates as users of the factory. Outputs are structured, deduplicated, and linked to exact files and lines. Triggers live inside existing tools rather than new ones. Noise gets tuned down relentlessly, because every false positive spends trust. And everything is packaged to share, so the engineer next to you can adopt your workflow in one copy-paste.
