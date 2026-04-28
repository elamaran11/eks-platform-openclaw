"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useScroll, useTransform } from "framer-motion";
import Link from "next/link";
import {
  ShieldCheck, Cpu, Lock, Sparkles, ArrowRight, Send,
  TrendingUp, Home, GraduationCap, Target, Zap, Eye,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Canned demo replies for the preview chat on the landing page.
// Chosen to show the assistant's style: frameworks, not advice; math,
// not guarantees; honest tradeoffs. Response streams out token-by-token
// so it feels live without touching Bedrock — the real chat is gated
// behind /app → Cognito.
const DEMO_REPLIES: Record<string, string> = {
  savings: `Here's a framework to think about it — not a prescription.

**Order-of-operations rule of thumb**

1. **401(k) to match** — anything else with a guaranteed 50–100% return is illegal.
2. **HSA, if you qualify** — triple tax advantage: deductible, grows tax-free, withdrawals for medical expenses tax-free. Often better than a 401(k) dollar for dollar.
3. **High-interest debt** — above ~6%, the math favors paying down over investing.
4. **Max tax-advantaged space** — 401(k) to limit, IRA/Roth per rules.
5. **Taxable brokerage** — flexibility, long-term capital gains rates.

**For your situation specifically**: the question I'd want to answer first is *what is this money for, and when?* A 529 optimizes for education; a taxable brokerage optimizes for "I want flexibility"; a backdoor Roth optimizes for tax-free growth over decades. These aren't substitutes for each other — they're different tools.

Want to work through a concrete split with numbers?`,
  retirement: `Good question to pressure-test. Let me lay out the assumptions that matter most, then stress-test.

**Baseline assumptions for your target**

- Target: $2M in today's dollars at age 55
- Current: $400k at age 38 (17 years out)
- Unknown: contribution rate, expected real return, inflation

**The 3% rule math** (real returns, after inflation)

If you assume a **5% real return** and contribute $30k/year:
> Future value ≈ $400k × 1.05^17 + $30k × ((1.05^17 − 1) / 0.05)
> ≈ $918k + $766k = **$1.68M** (shortfall ~$320k)

If you can push contributions to **$45k/year**:
> ≈ $918k + $1.15M = **$2.07M** (just over target)

**Sensitivities** (what breaks this)

- Real return 4% instead of 5%: target drops to ~$1.75M at $45k/year → miss
- 2 extra years of work to 57: huge, compounding is most of the gain late
- Health insurance gap 55 → 65 pre-Medicare: plan for $10–20k/year cost

I'd want to see your actual expected expenses in retirement next — the $2M number is only meaningful against a spending plan. Want to build that?`,
  rent: `The rent-vs-buy math has four inputs that dominate. Most online calculators get two of them wrong.

**The inputs that matter**

1. **Total unrecoverable cost** of owning: mortgage interest + property tax + maintenance (~1%/yr of home value) + HOA + transaction cost amortized over holding period
2. **Total unrecoverable cost** of renting: the rent itself
3. **Opportunity cost** of the down payment (what it would earn invested)
4. **Expected appreciation** (and honestly: nobody knows)

**For your $900k / 20% down / 7% scenario**

Roughly, the "unrecoverable" annual cost of the house is:
> Interest on $720k at 7% ≈ $50k/yr (year 1, drops slowly)
> + Property tax ~1.2% = $10.8k
> + Maintenance ~1% = $9k
> + Opportunity cost on $180k at 5% real = $9k
> = **~$79k/yr** unrecoverable

If comparable rent is **below $6,600/month**, renting is cheaper on an unrecoverable-cost basis. If it's above, buying starts to win — and the gap widens as you pay down principal.

**Variables that move the answer most**

- **How long you'll stay**: under 5 years, transaction cost alone kills the buy case
- **Your marginal tax rate**: if you itemize, interest/SALT deduction shifts the math
- **Rent growth vs home appreciation**: in SF Bay specifically, the last decade has made fools of both directions

Want to run your specific rent number and holding period?`,
  default: `Good question. Before I answer, two things I want to be clear about:

I'm an **educational thinking partner**, not a fiduciary. I don't know your accounts and can't recommend specific funds or stocks. For material decisions — retirement plan rollovers, Roth conversions above ~$10k, estate planning, insurance beyond term life — you should talk to a CFP, CPA, or estate attorney as appropriate.

With that said: most financial questions have a common structure. **What is the money for? When do you need it? What happens if you're wrong?** Those three questions resolve 80% of "should I X or Y" situations.

For what you asked — sign in to the full assistant and we can work through the specifics with your actual numbers, run scenario math, and save the analysis to your private workspace.`,
};

function matchReply(q: string): string {
  const s = q.toLowerCase();
  if (/sav|invest|401|roth|hsa|bracket/.test(s)) return DEMO_REPLIES.savings;
  if (/retire|55|60|65|fire/.test(s)) return DEMO_REPLIES.retirement;
  if (/rent|buy|hous|home|mortgag/.test(s)) return DEMO_REPLIES.rent;
  return DEMO_REPLIES.default;
}

const QUICK_ASKS = [
  { icon: TrendingUp,    label: "How should I split $3k/mo between retirement, 529, and brokerage?", key: "savings" },
  { icon: Home,          label: "Walk me through rent vs buy math for a $900k home.",                 key: "rent" },
  { icon: Target,        label: "I want to retire at 55 with $2M — what assumptions matter?",          key: "retirement" },
  { icon: GraduationCap, label: "529 vs UTMA for my kid — what are the real tradeoffs?",              key: "default" },
];

export default function Landing() {
  const { scrollY } = useScroll();
  const heroY = useTransform(scrollY, [0, 400], [0, -60]);
  const heroOpacity = useTransform(scrollY, [0, 300], [1, 0.35]);

  return (
    <main className="min-h-screen overflow-hidden">
      <Nav />

      {/* Hero */}
      <motion.section style={{ y: heroY, opacity: heroOpacity }} className="relative pt-24 pb-16 md:pt-36 md:pb-24">
        <BackgroundBlobs />
        <div className="relative max-w-6xl mx-auto px-6">
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }}
            className="text-center max-w-3xl mx-auto">
            <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.15, duration: 0.4 }}
              className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-accent-500/10 border border-accent-500/30 text-[11px] text-accent-400 uppercase tracking-widest mb-6">
              <ShieldCheck size={12}/> Hardware-isolated · Private by design
            </motion.div>
            <h1 className="text-5xl md:text-7xl font-semibold tracking-tight leading-[1.05]">
              <span className="bg-gradient-to-br from-ink-50 via-ink-100 to-ink-400 bg-clip-text text-transparent">A thinking partner for money.</span>
              <br/>
              <span className="bg-gradient-to-br from-accent-400 via-accent-500 to-gold-500 bg-clip-text text-transparent">Not a ticker.</span>
            </h1>
            <p className="mt-7 text-lg md:text-xl text-ink-300 max-w-2xl mx-auto leading-relaxed">
              An educational assistant that helps you reason clearly about budgeting, retirement, tax concepts, and major purchases. Frameworks, math, and honest tradeoffs — never specific picks or guaranteed returns.
            </p>
            <div className="mt-10 flex items-center justify-center gap-3 flex-wrap">
              <Link href="/login" className="btn-gradient group rounded-xl px-6 py-3.5 text-sm font-semibold flex items-center gap-2 shadow-xl shadow-accent-500/30 transition-all hover:shadow-accent-500/50">
                Get started <ArrowRight size={16} className="group-hover:translate-x-0.5 transition"/>
              </Link>
              <a href="#preview" className="rounded-xl px-6 py-3.5 text-sm font-semibold border border-ink-700 text-ink-200 hover:border-accent-500/50 hover:text-ink-100 transition">
                Try it live ↓
              </a>
            </div>
            <div className="mt-10 flex items-center justify-center gap-6 text-xs text-ink-500">
              <TrustChip icon={<Cpu size={12}/>} label="Kata VM"/>
              <TrustChip icon={<Lock size={12}/>} label="No account access"/>
              <TrustChip icon={<Eye size={12}/>} label="Per-user workspace"/>
            </div>
          </motion.div>
        </div>
      </motion.section>

      {/* Live preview */}
      <section id="preview" className="relative py-20 md:py-28">
        <div className="max-w-6xl mx-auto px-6">
          <SectionHeading
            eyebrow="Try before you sign in"
            title="Ask anything. Watch it think."
            body="This is a preview — a few canned replies to show the style. The real chat, with your private workspace, is one click away."
          />
          <LivePreview/>
        </div>
      </section>

      {/* What it's for */}
      <section className="relative py-20 md:py-28 border-t border-ink-900/80">
        <div className="max-w-6xl mx-auto px-6">
          <SectionHeading
            eyebrow="What you can ask"
            title="Real questions. Honest answers."
            body="These are the conversations people actually have. Not hot takes. Not hype."
          />
          <div className="grid md:grid-cols-3 gap-5">
            <FeatureCard
              icon={<TrendingUp/>}
              title="Savings frameworks"
              body="Order-of-operations for contributions, rule-of-thumb splits, how to think about 401(k) / HSA / Roth / taxable brokerage without anyone telling you to buy VTSAX."
            />
            <FeatureCard
              icon={<Home/>}
              title="Major purchase math"
              body="Rent vs buy broken down by unrecoverable cost. Total cost of owning a car beyond the sticker. How much house you can actually afford without lying to yourself."
            />
            <FeatureCard
              icon={<Target/>}
              title="Retirement stress tests"
              body="Not a calculator that assumes 7% forever. A back-and-forth about what happens if return is 1% lower, if inflation is 1% higher, if you retire 2 years later."
            />
            <FeatureCard
              icon={<GraduationCap/>}
              title="Tax concepts, explained"
              body="Marginal vs effective rates. What the AMT actually does. Why backdoor Roth requires a specific sequence. No advice — just mechanics."
            />
            <FeatureCard
              icon={<Zap/>}
              title="Benefit enrollment, decoded"
              body="ESPP, RSU vesting, HDHP vs PPO, HSA vs FSA. The actual numbers behind the options your employer hands you in a 200-slide deck."
            />
            <FeatureCard
              icon={<Sparkles/>}
              title="Your private workspace"
              body="Goals, snapshots, decision log, scenarios — saved across sessions in your own isolated space. No one sees it. Not even us."
            />
          </div>
        </div>
      </section>

      {/* Trust */}
      <section className="relative py-20 md:py-28 border-t border-ink-900/80">
        <div className="max-w-6xl mx-auto px-6">
          <SectionHeading
            eyebrow="Why you can trust it"
            title="Security isn't marketing copy."
            body="Each user's session runs in its own hardware-isolated Kata VM. Secrets live on tmpfs, never in env. A Bedrock guardrail blocks credentials and personal financial identifiers from touching the model."
          />
          <div className="grid md:grid-cols-3 gap-5">
            <TrustCard
              icon={<ShieldCheck/>}
              title="Per-user VM isolation"
              body="One kata-qemu VM per authenticated user. Another user's prompts cannot reach your workspace — the boundary is hardware, not trust."
            />
            <TrustCard
              icon={<Lock/>}
              title="No account access, ever"
              body="The assistant has no read connection to your bank, brokerage, 401(k) admin, or any financial institution. It only knows what you choose to type."
            />
            <TrustCard
              icon={<Eye/>}
              title="Audited guardrails"
              body="Denied topics (specific securities, guaranteed returns, insider info). PII block (SSN, account numbers, credentials). Every response filtered, input and output."
            />
          </div>
        </div>
      </section>

      {/* Disclosure */}
      <section className="py-16 border-t border-ink-900/80">
        <div className="max-w-3xl mx-auto px-6 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-ink-900/60 border border-ink-800 text-[11px] text-ink-400 uppercase tracking-widest mb-4">
            Disclosure
          </div>
          <p className="text-sm text-ink-400 leading-relaxed">
            Educational only. This is not financial, tax, legal, or investment advice. The assistant is not a fiduciary, CFP, CPA, or broker. For material decisions — retirement plan rollovers, Roth conversions above ~$10k, estate planning, insurance beyond term life — consult a licensed professional.
          </p>
        </div>
      </section>

      {/* Final CTA */}
      <section className="relative py-24 border-t border-ink-900/80">
        <BackgroundBlobs intensity={0.6}/>
        <div className="relative max-w-3xl mx-auto px-6 text-center">
          <h2 className="text-3xl md:text-5xl font-semibold tracking-tight leading-tight">
            <span className="bg-gradient-to-br from-ink-50 to-ink-400 bg-clip-text text-transparent">Stop Googling.</span>
            <br/>
            <span className="bg-gradient-to-br from-accent-400 to-gold-500 bg-clip-text text-transparent">Start thinking clearly.</span>
          </h2>
          <div className="mt-8 flex items-center justify-center gap-3">
            <Link href="/login" className="btn-gradient group rounded-xl px-7 py-4 text-sm font-semibold flex items-center gap-2 shadow-xl shadow-accent-500/30 transition-all hover:shadow-accent-500/50">
              Sign in to start <ArrowRight size={16} className="group-hover:translate-x-0.5 transition"/>
            </Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-ink-900/80 py-8">
        <div className="max-w-6xl mx-auto px-6 flex flex-col md:flex-row gap-4 items-center justify-between text-xs text-ink-500">
          <div>Finance Assistant — a private, hardware-isolated thinking partner.</div>
          <div className="flex gap-5">
            <Link href="/app" className="hover:text-ink-300">App</Link>
            <a href="#preview" className="hover:text-ink-300">Preview</a>
            <Link href="/login" className="hover:text-ink-300">Sign in</Link>
          </div>
        </div>
      </footer>
    </main>
  );
}

function Nav() {
  return (
    <header className="fixed top-0 left-0 right-0 z-50 backdrop-blur-xl bg-ink-950/60 border-b border-ink-900/60">
      <nav className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2.5 group">
          <div className="relative w-8 h-8 rounded-lg bg-gradient-to-br from-accent-400 to-gold-500 flex items-center justify-center text-ink-950 font-bold text-sm shadow-lg shadow-accent-500/20 group-hover:shadow-accent-500/40 transition">
            F
          </div>
          <span className="text-sm font-semibold tracking-tight">Finance Assistant</span>
        </Link>
        <div className="flex items-center gap-6 text-sm">
          <a href="#preview" className="text-ink-400 hover:text-ink-100 transition hidden sm:block">Preview</a>
          <Link href="/login" className="btn-gradient rounded-lg px-4 py-2 text-xs font-semibold">Sign in</Link>
        </div>
      </nav>
    </header>
  );
}

function BackgroundBlobs({ intensity = 1 }: { intensity?: number }) {
  return (
    <div aria-hidden className="absolute inset-0 pointer-events-none overflow-hidden">
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 1.2 }}
        className="absolute -top-40 left-1/2 -translate-x-1/2 w-[900px] h-[600px] rounded-full blur-3xl"
        style={{ background: `radial-gradient(ellipse, rgba(34,211,238,${0.18*intensity}) 0%, transparent 65%)` }}
      />
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 1.2, delay: 0.2 }}
        className="absolute -bottom-32 right-0 w-[700px] h-[500px] rounded-full blur-3xl"
        style={{ background: `radial-gradient(ellipse, rgba(251,191,36,${0.12*intensity}) 0%, transparent 60%)` }}
      />
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 0.5 }}
        transition={{ duration: 1.5 }}
        className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_0%,rgba(2,6,23,0.9)_80%)]"
      />
    </div>
  );
}

function TrustChip({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-accent-400">{icon}</span>
      <span>{label}</span>
    </span>
  );
}

function SectionHeading({ eyebrow, title, body }: { eyebrow: string; title: string; body: string }) {
  return (
    <div className="text-center mb-14 max-w-2xl mx-auto">
      <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-accent-500/10 border border-accent-500/30 text-[11px] text-accent-400 uppercase tracking-widest mb-4">
        {eyebrow}
      </div>
      <h2 className="text-3xl md:text-4xl font-semibold tracking-tight bg-gradient-to-br from-ink-50 to-ink-300 bg-clip-text text-transparent mb-4">
        {title}
      </h2>
      <p className="text-ink-400">{body}</p>
    </div>
  );
}

function FeatureCard({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      className="group rounded-2xl border border-ink-800 bg-ink-900/40 hover:border-accent-500/40 hover:bg-ink-900/70 p-6 transition"
    >
      <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-accent-500/25 to-gold-500/15 border border-accent-500/30 flex items-center justify-center text-accent-400 mb-4 group-hover:scale-110 transition">
        {icon}
      </div>
      <div className="text-sm font-semibold text-ink-100 mb-2">{title}</div>
      <p className="text-sm text-ink-400 leading-relaxed">{body}</p>
    </motion.div>
  );
}

function TrustCard({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.4 }}
      className="rounded-2xl border border-ink-800 bg-gradient-to-br from-ink-900/60 to-ink-900/20 p-6"
    >
      <div className="w-10 h-10 rounded-lg bg-accent-500/10 border border-accent-500/30 flex items-center justify-center text-accent-400 mb-4">
        {icon}
      </div>
      <div className="text-sm font-semibold text-ink-100 mb-2">{title}</div>
      <p className="text-sm text-ink-400 leading-relaxed">{body}</p>
    </motion.div>
  );
}

function LivePreview() {
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [msgs, setMsgs] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" });
  }, [msgs]);

  async function simulate(prompt: string, forceKey?: string) {
    if (streaming) return;
    setStreaming(true);
    setMsgs((m) => [...m, { role: "user", content: prompt }, { role: "assistant", content: "" }]);
    const full = forceKey ? (DEMO_REPLIES[forceKey] || DEMO_REPLIES.default) : matchReply(prompt);
    // Word-by-word streaming at ~40ms per word feels lifelike without
    // being slow. Total length stays under ~6s for any reply.
    const words = full.split(/(\s+)/);
    let acc = "";
    for (const w of words) {
      acc += w;
      await new Promise((r) => setTimeout(r, 22));
      setMsgs((m) => {
        const c = m.slice();
        c[c.length - 1] = { role: "assistant", content: acc };
        return c;
      });
    }
    setStreaming(false);
  }

  function onSend() {
    const v = input.trim();
    if (!v) return;
    setInput("");
    simulate(v);
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.6 }}
      className="rounded-3xl border border-ink-800 bg-ink-900/40 backdrop-blur-sm overflow-hidden shadow-2xl shadow-black/40"
    >
      {/* Browser chrome */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-ink-800/80 bg-ink-950/40">
        <div className="flex gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-ink-700"/>
          <span className="w-2.5 h-2.5 rounded-full bg-ink-700"/>
          <span className="w-2.5 h-2.5 rounded-full bg-ink-700"/>
        </div>
        <div className="flex-1 text-center text-[11px] text-ink-500 font-mono tracking-tight">
          finassist.elamaras.people.aws.dev/app
        </div>
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 uppercase tracking-wider">Live</span>
      </div>

      {/* Chat area */}
      <div ref={ref} className="h-[480px] overflow-y-auto p-6 space-y-5">
        {msgs.length === 0 ? (
          <div className="flex flex-col gap-4 items-center justify-center h-full text-center">
            <div className="text-ink-500 text-sm">Try a question below — watch it think.</div>
            <div className="grid sm:grid-cols-2 gap-2 max-w-2xl w-full">
              {QUICK_ASKS.map((q) => (
                <button
                  key={q.label}
                  onClick={() => simulate(q.label, q.key)}
                  className="group text-left rounded-xl border border-ink-800 bg-ink-900/60 hover:border-accent-500/40 hover:bg-ink-900/90 p-3 transition flex items-start gap-2.5"
                >
                  <div className="w-7 h-7 shrink-0 rounded-lg bg-accent-500/10 border border-accent-500/30 flex items-center justify-center text-accent-400 mt-0.5">
                    <q.icon size={14}/>
                  </div>
                  <span className="text-xs text-ink-300 group-hover:text-ink-100 leading-relaxed">{q.label}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          msgs.map((m, i) => <PreviewMessage key={i} role={m.role} content={m.content} last={i === msgs.length-1 && streaming}/>)
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-ink-800/80 p-4 bg-ink-950/40">
        <div className="flex items-center gap-3 rounded-xl border border-ink-800 bg-ink-900/80 focus-within:border-accent-500/50 focus-within:ring-2 focus-within:ring-accent-500/20 transition">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") onSend(); }}
            placeholder="Ask about budgeting, retirement math, rent vs buy…"
            className="flex-1 bg-transparent px-4 py-3 text-sm placeholder:text-ink-500 focus:outline-none"
            disabled={streaming}
          />
          <button
            onClick={onSend}
            disabled={streaming || !input.trim()}
            className="m-1.5 rounded-lg w-9 h-9 flex items-center justify-center btn-gradient disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Send size={14}/>
          </button>
        </div>
        <div className="mt-3 flex items-center justify-between text-[11px] text-ink-500">
          <span>Preview only — canned replies. Real chat runs in an isolated VM after sign in.</span>
          <Link href="/login" className="text-accent-400 hover:text-accent-300 font-medium">Sign in →</Link>
        </div>
      </div>
    </motion.div>
  );
}

function PreviewMessage({ role, content, last }: { role: "user"|"assistant"; content: string; last: boolean }) {
  const isUser = role === "user";
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
      className={`flex gap-3 ${isUser ? "justify-end" : ""}`}
    >
      {!isUser && (
        <div className="w-7 h-7 shrink-0 rounded-lg bg-gradient-to-br from-accent-400 to-gold-500 flex items-center justify-center text-ink-950 font-bold text-[11px] mt-1">F</div>
      )}
      <div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm ${isUser ? "bg-gradient-to-br from-accent-500 to-accent-600 text-white" : "bg-ink-900/80 border border-ink-800"}`}>
        {isUser ? (
          <span className="whitespace-pre-wrap">{content}</span>
        ) : (
          <div className="prose-finance text-sm">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content || "…"}</ReactMarkdown>
            {last && content && <span className="inline-block w-1.5 h-4 bg-accent-400 animate-pulse ml-0.5 align-middle"/>}
          </div>
        )}
      </div>
    </motion.div>
  );
}
