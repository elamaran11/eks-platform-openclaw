"use client";

import { useState, useRef, useEffect } from "react";
import { Send, FileText, Target, History, HelpCircle } from "lucide-react";

type Msg = { role: "user" | "assistant"; content: string };

export default function Page() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scroll.current?.scrollTo(0, scroll.current.scrollHeight);
  }, [messages]);

  async function send() {
    if (!input.trim() || streaming) return;
    const next: Msg[] = [...messages, { role: "user", content: input }];
    setMessages(next);
    setInput("");
    setStreaming(true);

    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: next, model: "claude-sonnet-4-6" }),
    });

    if (!res.body) { setStreaming(false); return; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let assistant = "";
    setMessages(m => [...m, { role: "assistant", content: "" }]);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const j = JSON.parse(data);
          const delta = j.choices?.[0]?.delta?.content ?? "";
          assistant += delta;
          setMessages(m => {
            const copy = m.slice();
            copy[copy.length - 1] = { role: "assistant", content: assistant };
            return copy;
          });
        } catch {}
      }
    }
    setStreaming(false);
  }

  return (
    <main className="grid h-screen grid-cols-[260px_1fr_320px] bg-slate-950 text-slate-100">
      <aside className="border-r border-slate-800 p-4 space-y-6">
        <div>
          <div className="text-xs uppercase tracking-wider text-slate-500 mb-2">Workspace</div>
          <NavItem icon={<Target size={16} />} label="Goals" />
          <NavItem icon={<FileText size={16} />} label="Snapshot" />
          <NavItem icon={<History size={16} />} label="Decisions" />
          <NavItem icon={<HelpCircle size={16} />} label="Questions" />
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-slate-500 mb-2">Scenarios</div>
          <div className="text-sm text-slate-400">None saved yet.</div>
        </div>
        <div className="pt-4 border-t border-slate-800 text-xs text-slate-500">
          Educational only. Not advice. Consult a CFP for material decisions.
        </div>
      </aside>

      <section className="flex flex-col">
        <header className="border-b border-slate-800 p-4">
          <h1 className="font-semibold">Personal Financial Assistant</h1>
          <p className="text-xs text-slate-500">Hardware-isolated. No account access. Your data stays in your workspace.</p>
        </header>
        <div ref={scroll} className="flex-1 overflow-y-auto p-6 space-y-6">
          {messages.length === 0 && (
            <div className="text-slate-500 max-w-xl">
              <p className="mb-3">Ask about retirement math, debt payoff strategy, benefits enrollment, document review, or any concept you want explained without the jargon.</p>
              <p>I keep notes in your workspace so we can pick up where we left off.</p>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={m.role === "user" ? "flex justify-end" : ""}>
              <div className={`max-w-2xl whitespace-pre-wrap rounded-lg px-4 py-3 ${
                m.role === "user" ? "bg-sky-600 text-white" : "bg-slate-900 text-slate-100"
              }`}>
                {m.content || (streaming && i === messages.length - 1 ? "…" : "")}
              </div>
            </div>
          ))}
        </div>
        <div className="border-t border-slate-800 p-4">
          <div className="flex gap-2">
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              rows={2}
              placeholder="Ask anything — e.g., 'what happens if I max my 401k and Roth IRA for 20 years at 7% returns?'"
              className="flex-1 resize-none rounded-lg bg-slate-900 border border-slate-800 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-sky-600"
            />
            <button onClick={send} disabled={streaming}
              className="rounded-lg bg-sky-600 px-4 hover:bg-sky-500 disabled:opacity-50">
              <Send size={18} />
            </button>
          </div>
        </div>
      </section>

      <aside className="border-l border-slate-800 p-4">
        <div className="text-xs uppercase tracking-wider text-slate-500 mb-2">Artifacts</div>
        <div className="text-sm text-slate-400">
          Scenario charts and document summaries will appear here when the assistant produces them.
        </div>
      </aside>
    </main>
  );
}

function NavItem({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <button className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-slate-300 hover:bg-slate-900">
      {icon}<span>{label}</span>
    </button>
  );
}
