import { useState, useRef, useCallback, useEffect } from "react";

// ── INSIGHTS REPOSITORY ──────────────────────────────────────────────────────
// Living store: accumulates entries from every Meta + Google upload over time.
// Structure: { meta: { entries: [...], consolidated: {...} }, google: { ... } }
// Each entry: { date, source, best: [...], worst: [...], summary }
// consolidated: all-time best/worst merged + running summary

const EMPTY_REPO = { meta: { entries: [], consolidated: null }, google: { entries: [], consolidated: null } };

function loadRepo() {
  try {
    const s = localStorage.getItem('acg_repo_v1');
    if (s) return JSON.parse(s);
    // Migrate from old format if present
    const old = localStorage.getItem('acg_insights_v1');
    if (old) {
      const d = JSON.parse(old);
      if (d.meta?.best?.length) {
        return {
          meta: { entries: [{ date: d.fetched_at || new Date().toISOString(), source: "Migrated from previous data", best: d.meta.best, worst: d.meta.worst, summary: d.meta.summary }], consolidated: { best: d.meta.best, worst: d.meta.worst, summary: d.meta.summary } },
          google: { entries: [], consolidated: null },
        };
      }
    }
    return EMPTY_REPO;
  } catch { return EMPTY_REPO; }
}

function buildConsolidated(entries) {
  if (!entries.length) return null;
  // Collect all best/worst across all entries, de-dup by ad_name+headline, keep best CPL for duplicates
  const bestMap = {}, worstMap = {};
  entries.forEach(e => {
    (e.best || []).forEach(a => {
      const key = (a.ad_name + '|' + (a.headline || '')).toLowerCase();
      if (!bestMap[key] || a.cpl < bestMap[key].cpl) bestMap[key] = a;
    });
    (e.worst || []).forEach(a => {
      const key = (a.ad_name + '|' + (a.headline || '')).toLowerCase();
      if (!worstMap[key] || a.cpl > worstMap[key].cpl) worstMap[key] = a;
    });
  });
  const best  = Object.values(bestMap).sort((a,b) => a.cpl - b.cpl).slice(0, 10);
  const worst = Object.values(worstMap).sort((a,b) => b.cpl - a.cpl).slice(0, 10);
  // Use the most recent entry's summary as the consolidated summary
  const summary = entries[entries.length - 1]?.summary || "";
  return { best, worst, summary, entry_count: entries.length, last_updated: entries[entries.length - 1]?.date };
}

function saveRepo(repo) {
  try { localStorage.setItem('acg_repo_v1', JSON.stringify(repo)); } catch {}
}

const BASE_PROJECTS = {};

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MDL = "claude-sonnet-4-20250514";

const PARAM_META = {
  hook_strength:              { label: "Hook Strength",               desc: "Does the first line / visual stop the scroll?" },
  emotional_resonance:        { label: "Emotional Resonance",         desc: "Dignity, aspiration, family pride for 60+ Indian seniors" },
  clarity_of_offer:           { label: "Clarity of Offer",            desc: "Price anchor, location, CTA, offer specificity" },
  cultural_fit:               { label: "Cultural Fit (Tamil Nadu)",   desc: "South Indian values, family, devotional, dignified ageing" },
  sense_of_urgency:           { label: "Sense of Urgency",            desc: "Scarcity, time-bound offer, Grihapravesam hook" },
  character_limit_compliance: { label: "Character Limit Compliance",  desc: "Meta primary text, headline, description limits" },
  predicted_cpl_tier:         { label: "Predicted CPL Tier",          desc: "Expected CPL: Low ₹80–200 / Mid ₹200–500 / High ₹500+" },
};

// ── Video frame extraction via Railway backend ─────────────────────────────
const RAILWAY_FRAMES_URL = "https://web-production-baccd.up.railway.app/extract-frames";

async function extractVideoFrames(file, frameCount = 8) {
  const formData = new FormData();
  formData.append("video", file);
  formData.append("frames", String(frameCount));

  const res = await fetch(RAILWAY_FRAMES_URL, { method: "POST", body: formData });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Server error ${res.status}`);
  }
  const data = await res.json();
  if (!data.frames?.length) throw new Error("No frames returned from server");

  // Attach dataUrl for preview
  return {
    frames: data.frames.map(f => ({
      ...f,
      dataUrl: `data:image/jpeg;base64,${f.b64}`,
    })),
    duration: data.duration,
  };
}
async function callClaude(system, messages, maxTokens = 8000) {
  // Deep-clone and sanitize all image media_types before sending
  const safeMessages = JSON.parse(JSON.stringify(messages));
  safeMessages.forEach(msg => {
    if (Array.isArray(msg.content)) {
      msg.content.forEach(block => {
        if (block.type === "image" && block.source) {
          const t = (block.source.media_type || "").toLowerCase();
          block.source.media_type =
            t.includes("png")  ? "image/png"  :
            t.includes("gif")  ? "image/gif"  :
            t.includes("webp") ? "image/webp" :
            "image/jpeg";
        }
      });
    }
  });
  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": import.meta.env.VITE_ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify({ model: MDL, max_tokens: maxTokens, system, messages: safeMessages }),
  });
  if (!res.ok) throw new Error("API " + res.status + ": " + (await res.text()).slice(0, 200));
  const d = await res.json();
  return d.content?.filter(b => b.type === "text").map(b => b.text).join("") || "";
}
function safeJSON(text) {
  text = text.trim().replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s !== -1 && e > s) return JSON.parse(text.slice(s, e + 1));
  throw new Error("No JSON found");
}
function toB64(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.onerror = rej; r.readAsDataURL(file); });
}
function normalizeMediaType(t) {
  if (!t) return "image/jpeg";
  const s = t.toLowerCase();
  if (s.includes("png"))  return "image/png";
  if (s.includes("gif"))  return "image/gif";
  if (s.includes("webp")) return "image/webp";
  return "image/jpeg";
}
function ago(ts) {
  const d = Math.floor((Date.now() - ts) / 86400000);
  return d < 1 ? "today" : d + "d ago";
}
function copyToClipboard(text, setCopied) {
  navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); });
}

// ── Small components ───────────────────────────────────────────────────────────
function CharBadge({ text, max }) {
  const n = (text || "").length, ok = n <= max;
  return <span style={{ fontFamily: "monospace", fontSize: 10, padding: "2px 5px", borderRadius: 5, background: ok ? "#DCFCE7" : "#FEE2E2", color: ok ? "#166534" : "#991B1B", fontWeight: ok ? 500 : 700 }}>{n}/{max}</span>;
}
function CopyBtn({ text }) {
  const [done, setDone] = useState(false);
  return <button onClick={() => copyToClipboard(text, setDone)} style={{ fontSize: 10, padding: "2px 7px", borderRadius: 5, border: "1px solid " + (done ? "#86EFAC" : "#E2E8F0"), background: done ? "#DCFCE7" : "transparent", color: done ? "#166534" : "#94A3B8", cursor: "pointer" }}>{done ? "✓" : "Copy"}</button>;
}
function Field({ label, val, max }) {
  return (
    <div style={{ background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 10, padding: "9px 11px", marginBottom: 7 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
        <span style={{ fontSize: 9, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: ".07em" }}>{label}</span>
        <div style={{ display: "flex", gap: 5, alignItems: "center" }}>{max && <CharBadge text={val} max={max} />}<CopyBtn text={val || ""} /></div>
      </div>
      <div style={{ fontSize: 12, color: val ? "#1E293B" : "#CBD5E1", lineHeight: 1.5, fontStyle: val ? "normal" : "italic" }}>{val || "—"}</div>
    </div>
  );
}

// ── Variation card ─────────────────────────────────────────────────────────────
function VarCard({ v, idx, onRate }) {
  const [open, setOpen] = useState(idx === 0);
  const [sub, setSub] = useState("meta");
  const colors = [["#7C3AED", "#F5F3FF"], ["#B45309", "#FFFBEB"], ["#059669", "#F0FDF4"]];
  const [ac, bg] = colors[idx % 3];
  const rsa = v.google_rsa || {}, std = v.google_standard || {};
  const overH = (rsa.headlines || []).filter(h => h.length > 30).length;
  return (
    <div style={{ border: "1px solid #E2E8F0", borderRadius: 14, overflow: "hidden", marginBottom: 9 }}>
      <button onClick={() => setOpen(!open)} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 14px", background: open ? bg : "#fff", border: "none", cursor: "pointer", textAlign: "left" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <span style={{ fontSize: 10, fontWeight: 700, padding: "3px 9px", borderRadius: 100, background: ac + "20", color: ac }}>V{idx + 1}</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: "#1E293B" }}>{v.angle || "Variation " + (idx + 1)}</span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {onRate && <span onClick={e => { e.stopPropagation(); onRate(v); }} style={{ fontSize: 10, fontWeight: 700, padding: "3px 9px", borderRadius: 100, background: "#FEF9C3", color: "#92400E", cursor: "pointer" }}>⭐ Rate</span>}
          <span style={{ color: "#CBD5E1", fontSize: 10 }}>{open ? "▲" : "▼"}</span>
        </div>
      </button>
      {open && (
        <div style={{ borderTop: "1px solid #F1F5F9" }}>
          <div style={{ display: "flex", borderBottom: "1px solid #F1F5F9" }}>
            {[["meta", "Meta"], ["rsa", "Google RSA"], ["std", "Google Std"]].map(([id, lbl]) => (
              <button key={id} onClick={() => setSub(id)} style={{ flex: 1, fontSize: 11, padding: "8px 4px", fontWeight: 600, border: "none", borderBottom: sub === id ? "2px solid " + ac : "2px solid transparent", background: sub === id ? bg : "transparent", color: sub === id ? ac : "#94A3B8", cursor: "pointer" }}>{lbl}</button>
            ))}
          </div>
          <div style={{ padding: 13 }}>
            {sub === "meta" && <>
              <Field label="Primary Text" val={v.meta?.primary_text} max={150} />
              <Field label="Headline" val={v.meta?.headline} max={40} />
              <Field label="Description" val={v.meta?.description} max={30} />
              <button onClick={() => navigator.clipboard.writeText(`Primary Text:\n${v.meta?.primary_text || ""}\n\nHeadline:\n${v.meta?.headline || ""}\n\nDescription:\n${v.meta?.description || ""}`)} style={{ width: "100%", padding: 7, borderRadius: 9, border: "1px solid " + ac + "40", background: "transparent", color: ac, fontSize: 11, fontWeight: 600, cursor: "pointer", marginTop: 4 }}>Copy All Meta Copy</button>
            </>}
            {sub === "rsa" && <>
              {overH > 0 && <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "6px 10px", marginBottom: 9, fontSize: 11, color: "#92400E" }}>⚠ {overH} headline(s) over 30 chars</div>}
              <div style={{ fontSize: 9, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 7 }}>Headlines (max 30 chars)</div>
              {(rsa.headlines || []).map((h, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 7, padding: "5px 9px", marginBottom: 3, gap: 7 }}>
                  <span style={{ fontSize: 9, color: "#CBD5E1", width: 18 }}>H{i + 1}</span>
                  <span style={{ fontSize: 12, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h}</span>
                  <div style={{ display: "flex", gap: 4 }}><CharBadge text={h} max={30} /><CopyBtn text={h} /></div>
                </div>
              ))}
              <div style={{ fontSize: 9, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: ".07em", margin: "12px 0 7px" }}>Descriptions (max 90 chars)</div>
              {(rsa.descriptions || []).map((d, i) => <Field key={i} label={"D" + (i + 1)} val={d} max={90} />)}
            </>}
            {sub === "std" && <>
              <Field label="Headline 1" val={std.headline_1} max={30} />
              <Field label="Headline 2" val={std.headline_2} max={30} />
              <Field label="Headline 3" val={std.headline_3} max={30} />
              <Field label="Description 1" val={std.description_1} max={90} />
              <Field label="Description 2" val={std.description_2} max={90} />
            </>}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Rating display ─────────────────────────────────────────────────────────────
function RatingDisplay({ rating, creative }) {
  const overall = rating.overall_score || 0;
  const oc = rating.overall_colour || "amber";
  const oBg = { green: "#DCFCE7", amber: "#FFFBEB", red: "#FEE2E2" }[oc];
  const oC  = { green: "#166534", amber: "#92400E", red: "#991B1B" }[oc];
  return (
    <div>
      <div style={{ background: oBg, border: "1px solid " + (oc === "green" ? "#86EFAC" : oc === "amber" ? "#FDE68A" : "#FECACA"), borderRadius: 18, padding: 20, textAlign: "center", marginBottom: 18 }}>
        {creative && <img src={creative.preview} alt="" style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 10, border: "2px solid #fff", marginBottom: 10 }} />}
        <div style={{ fontSize: 48, fontWeight: 800, color: oC, lineHeight: 1 }}>{overall}<span style={{ fontSize: 20 }}>/10</span></div>
        <div style={{ fontSize: 12, fontWeight: 600, color: oC, margin: "4px 0 10px" }}>Overall Score</div>
        <div style={{ fontSize: 13, color: oC, lineHeight: 1.6, maxWidth: 480, margin: "0 auto" }}>{rating.overall_summary}</div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9 }}>
        {Object.entries(rating.parameters || {}).map(([key, val]) => {
          const dotC = { green: "#22C55E", amber: "#F59E0B", red: "#EF4444" }[val.colour] || "#F59E0B";
          const sc   = { green: "#16A34A", amber: "#D97706", red: "#DC2626" }[val.colour] || "#D97706";
          const bg   = { green: "#F0FDF4", amber: "#FFFBEB", red: "#FEF2F2" }[val.colour] || "#FFFBEB";
          return (
            <div key={key} style={{ background: bg, border: "1px solid " + (val.colour === "green" ? "#BBF7D0" : val.colour === "red" ? "#FECACA" : "#FDE68A"), borderRadius: 13, padding: "12px 13px" }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 7 }}>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#1E293B" }}>{PARAM_META[key]?.label || key}</div>
                  <div style={{ fontSize: 10, color: "#64748B", marginTop: 2 }}>{PARAM_META[key]?.desc}</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0, marginLeft: 8 }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: dotC }} />
                  <span style={{ fontSize: 18, fontWeight: 800, color: sc }}>{val.score}</span>
                </div>
              </div>
              <div style={{ fontSize: 11, color: "#374151", lineHeight: 1.5 }}>{val.rationale}</div>
              {val.suggestion && (
                <div style={{ marginTop: 8, background: "#F5F3FF", borderLeft: "3px solid #7C3AED", borderRadius: "0 7px 7px 0", padding: "7px 10px" }}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: "#7C3AED", textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 3 }}>💡 Suggestion</div>
                  <div style={{ fontSize: 11, color: "#4C1D95", lineHeight: 1.5 }}>{val.suggestion}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── MAIN APP ───────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState("promptgen");
  const [projKey, setProjKey] = useState("sattva");
  const [projects, setProjects] = useState(() => {
    try { const s = localStorage.getItem("acg_proj_v1"); return s ? JSON.parse(s) : { ...BASE_PROJECTS }; } catch { return { ...BASE_PROJECTS }; }
  });
  const [creatives, setCreatives] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [history, setHistory] = useState(() => { try { return JSON.parse(localStorage.getItem("acg_hist_v1") || "[]"); } catch { return []; } });
  const [repo, setRepo] = useState(() => loadRepo());
  const [rateTarget, setRateTarget] = useState(null);
  const [rating, setRating] = useState(null);
  const [ratingLoading, setRatingLoading] = useState(false);
  const [ratingError, setRatingError] = useState("");
  const [metaStatus, setMetaStatus] = useState({ loading: false, error: false, msg: "" });
  const [smFile, setSmFile] = useState(null);
  const [smProjKey, setSmProjKey] = useState("sattva");
  const [smPlatforms, setSmPlatforms] = useState(["facebook", "instagram"]);
  const [smContext, setSmContext] = useState("");
  const [smLoading, setSmLoading] = useState(false);
  const [smResult, setSmResult] = useState(null);
  const [smError, setSmError] = useState("");
  const [pgFile, setPgFile] = useState(null);
  const [pgTool, setPgTool] = useState("midjourney");
  const [pgContext, setPgContext] = useState("");
  const [pgLoading, setPgLoading] = useState(false);
  const [pgResult, setPgResult] = useState(null);
  const [pgError, setPgError] = useState("");
  const [googleStatus, setGoogleStatus] = useState({ loading: false, error: false, msg: "" });
  const [toast, setToast] = useState(null);
  const fileRef = useRef();

  // Load SheetJS for Excel parsing
  useEffect(() => {
    if (!window.XLSX) {
      const s = document.createElement("script");
      s.src = "https://cdn.sheetjs.com/xlsx-0.20.1/package/dist/xlsx.full.min.js";
      document.head.appendChild(s);
    }
  }, []);

  // New project form state
  const [npName, setNpName] = useState(""); const [npSub, setNpSub] = useState("");
  const [npLoc, setNpLoc] = useState("");  const [npUnits, setNpUnits] = useState("");
  const [npTag, setNpTag] = useState("");  const [npTgt, setNpTgt] = useState("");
  const [npHl, setNpHl] = useState("");

  const processReport = async (file, platform) => {
    const setStatus = platform === "meta" ? setMetaStatus : setGoogleStatus;
    setStatus({ loading: true, error: false, msg: "Reading " + file.name + "…" });

    try {
      const buf = await file.arrayBuffer();
      let rows = [];

      if (file.name.toLowerCase().endsWith(".csv")) {
        const text = new TextDecoder().decode(buf);
        const rawLines = text.split(/\r?\n/).filter(l => l.trim());
        const headers = rawLines[0].split(",").map(h => h.replace(/"/g,"").trim());
        rows = rawLines.slice(1).map(line => {
          const vals = line.match(/(".*?"|[^,]+)(?=,|$)/g) || [];
          const row = {};
          headers.forEach((h, i) => { row[h] = (vals[i] || "").replace(/"/g,"").trim(); });
          return row;
        });
      } else {
        const XLSX = window.XLSX;
        if (!XLSX) throw new Error("SheetJS not loaded — please try again in a moment");
        const wb = XLSX.read(buf, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
      }

      if (!rows.length) throw new Error("No data rows found in file");
      setStatus({ loading: true, error: false, msg: `Parsed ${rows.length} rows — analysing with Claude…` });

      const trimmed = rows.slice(0, 100);
      const isGoogle = platform === "google";

      const systemPrompt = isGoogle
        ? `You are an ad performance analyst for Elements Senior Living, Tamil Nadu.
Analyse this Google Ads report. Look for columns like: Campaign, Ad group, Headline 1, Description 1, Cost, Conversions, Conv. rate, CTR, Cost/conv.
Compute CPL = cost / conversions where not directly given. Only include ads with 3+ conversions.
Return ONLY valid JSON:
{"best":[{"ad_name":"","campaign_name":"","cpl":0,"conversions":0,"ctr":0.0,"headline":"","description":""}],"worst":[{"ad_name":"","campaign_name":"","cpl":0,"conversions":0,"ctr":0.0,"headline":"","description":""}],"summary":"2 sentences: what headline/description patterns drive conversions and what to avoid for senior living search ads"}
Return top 5 best (lowest CPL) and top 5 worst (highest CPL).`
        : `You are an ad performance analyst for Elements Senior Living, Tamil Nadu.
Analyse this Meta Ads report. Look for columns like: Ad name, Campaign name, Primary text / Body / Ad Body / Message, Headline / Title, Spend / Amount spent, Results / Leads, Cost per result / CPL, CTR / Link CTR.
Compute CPL = spend / results where not directly given. Only include ads with 5+ leads.
Return ONLY valid JSON:
{"best":[{"ad_name":"","campaign_name":"","cpl":0,"conversions":0,"ctr":0.0,"headline":"","primary_text":""}],"worst":[{"ad_name":"","campaign_name":"","cpl":0,"conversions":0,"ctr":0.0,"headline":"","primary_text":""}],"summary":"2 sentences: what copy angles and hooks drive low CPL and what patterns to avoid, specific to Tamil Nadu senior living audience"}
Return top 5 best (lowest CPL) and top 5 worst (highest CPL).`;

      const raw = await callClaude(systemPrompt,
        [{ role: "user", content: `Report: ${file.name}\nData (first 100 rows):\n${JSON.stringify(trimmed, null, 2)}` }],
        3000
      );

      const parsed = safeJSON(raw);
      if (!parsed.best || !parsed.worst) throw new Error("Unexpected response format");

      const newEntry = {
        date: new Date().toISOString(),
        source: file.name,
        best: parsed.best,
        worst: parsed.worst,
        summary: parsed.summary,
      };

      setRepo(prevRepo => {
        const updated = JSON.parse(JSON.stringify(prevRepo));
        updated[platform].entries.push(newEntry);
        updated[platform].consolidated = buildConsolidated(updated[platform].entries);
        saveRepo(updated);
        return updated;
      });

      setStatus({ loading: false, error: false, msg: `✓ ${parsed.best.length + parsed.worst.length} ads analysed from ${file.name} · ${new Date().toLocaleDateString("en-IN")}` });
      showToast(`${platform === "meta" ? "Meta" : "Google"} insights added ✓`);
    } catch(err) {
      setStatus({ loading: false, error: true, msg: err.message });
    }
  };

  const generateSocialCopy = async () => {
    if (!smFile || !smPlatforms.length) return;
    setSmLoading(true); setSmResult(null); setSmError("");

    const smProj = projects[smProjKey] || projects[Object.keys(projects)[0]] || { name: "No project", subtitle: "", location: "", highlights: [], color: "#94A3B8", tagline: "", target: "", units: "", custom_kb: "" };
    const smBest  = insights?.meta?.best  || [];
    const smWorst = insights?.meta?.worst || [];
    const smInsCtx = smBest.length > 0 ? [
      "CAMPAIGN INSIGHTS — top performing copy patterns:",
      ...smBest.slice(0, 3).map(a => `[₹${a.cpl} CPL | ${a.ad_name}] "${a.headline}" — "${(a.primary_text || "").slice(0, 150)}"`),
      "UNDERPERFORMERS — avoid these patterns:",
      ...smWorst.slice(0, 2).map(a => `[₹${a.cpl} CPL | ${a.ad_name}] "${a.headline}" — "${(a.primary_text || "").slice(0, 100)}"`),
      "COPY INTELLIGENCE: " + (insights?.meta?.summary || ""),
    ].join("\n") : "";

    const PLATFORM_RULES = {
      facebook: {
        name: "Facebook",
        rules: `FACEBOOK POST:
- Primary text: 1–3 short punchy paragraphs. Hook in first line (no truncation after "See more").
- Warm, conversational, aspirational tone — talk to adult children 30–45 looking for their parents
- Use 2–4 emojis max, placed naturally (not at start of every line)
- End with a soft CTA: "Drop a comment", "Tag someone", "Call us today", or "DM for details"
- Ideal length: 80–150 words
- Optional: 3–5 relevant hashtags at end`,
      },
      instagram: {
        name: "Instagram",
        rules: `INSTAGRAM CAPTION:
- First line is the hook — must stop the scroll. Bold claim, question, or emotional statement.
- Body: 2–3 short paragraphs, line breaks between them for readability
- Warm, visual, lifestyle-forward tone — paint a picture of the life seniors will live
- 5–10 relevant hashtags at end, mix of broad (#seniorliving) and niche (#ChennaiSeniors #ActiveRetirement)
- End with a CTA: "Link in bio", "DM us", or "Save this post"
- Emojis: 3–6, used with intention
- Ideal length: 100–180 words + hashtags`,
      },
      linkedin: {
        name: "LinkedIn",
        rules: `LINKEDIN POST:
- Opening line: a bold insight, personal story hook, or contrarian statement — no "I'm excited to share"
- Structure: Hook → Context → Insight/Value → CTA
- Professional but human tone — write for developers of senior living and decision-making adult children
- No emojis or max 1–2 subtle ones
- Line breaks every 1–2 sentences for readability (LinkedIn is scanned, not read)
- CTA: "What do you think?", "Would love your thoughts", or "DM me to learn more"
- Ideal length: 150–250 words
- 3–5 professional hashtags at end (#SeniorLiving #RealEstate #ActiveAging)`,
      },
    };

    const selectedRules = smPlatforms.map(p => PLATFORM_RULES[p]).filter(Boolean);

    const system = `You are a social media copywriter for Elements Senior Living — premium senior living communities in Tamil Nadu, India.

PROJECT: ${smProj.name} — ${smProj.subtitle}
LOCATION: ${smProj.location}
UNITS: ${smProj.units}
TAGLINE: ${smProj.tagline}
TARGET AUDIENCE: ${smProj.target}
KEY HIGHLIGHTS:
${(smProj.highlights || []).map(h => "- " + h).join("\n")}

BRAND TONE: Warm, dignified, aspirational — NEVER institutional or clinical. Never use "old age home" — always "senior living", "active retirement", "golden years". South Indian / Tamil Nadu cultural values: family respect, peaceful lifestyle, community, vegetarian.

${smInsCtx ? "WHAT WORKS IN THIS ACCOUNT (apply these patterns to social copy):\n" + smInsCtx + "\n" : ""}
${smContext ? "ADDITIONAL DIRECTION:\n" + smContext + "\n" : ""}
Generate copy for these platforms:
${selectedRules.map(p => "\n### " + p.name + "\n" + p.rules).join("")}

Analyse the uploaded image carefully — describe what you see (people, setting, mood, colours) and use those details to write copy that feels like it was written specifically for THIS creative.

Return ONLY valid JSON with one key per selected platform. Each value: {"copy":"[post body without hashtags]","hashtags":"[hashtag string or empty]"}.`;

    try {
      const mediaContent = smFile.isVideo && smFile.frames
        ? [
            ...smFile.frames.map(fr => ([
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: fr.b64 } },
              { type: "text", text: `[Frame ${fr.timeIndex}/${smFile.frames.length} — ${fr.timeLabel}]` },
            ])).flat(),
            { type: "text", text: `These ${smFile.frames.length} frames are evenly sampled from the full video. Analyse the people, setting, mood, motion, and visual story across all frames, then write social media copy for: ${smPlatforms.join(", ")}. JSON only.` },
          ]
        : [
            { type: "image", source: { type: "base64", media_type: normalizeMediaType(smFile.mediaType), data: smFile.b64 } },
            { type: "text", text: `Analyse this image and write social media copy for: ${smPlatforms.join(", ")}. JSON only.` },
          ];
      const raw = await callClaude(system, [{ role: "user", content: mediaContent }], 2000);
      setSmResult(safeJSON(raw));
    } catch(e) {
      setSmError(e.message);
    }
    setSmLoading(false);
  };

  const generatePrompt = async () => {
    if (!pgFile) return;
    setPgLoading(true); setPgResult(null); setPgError("");

    const TOOL_RULES = {
      midjourney: {
        name: "Midjourney v6",
        syntax: `SYNTAX RULES — MIDJOURNEY v6:
- Comma-separated descriptors, NOT prose sentences
- Structure: [Subject], [environment/setting], [style keyword], [mood/atmosphere], [lighting], [composition/camera], [technical quality descriptors]
- Parameters ALWAYS at the very end: --ar [ratio] --v 6 --style raw (add --no [unwanted elements] if needed)
- Subject first — most important descriptor leads
- Style examples: cinematic photography, editorial portrait, golden hour film, photorealistic, documentary style
- Do NOT write full sentences — only descriptor phrases separated by commas
- Output a SINGLE Midjourney prompt ready to paste, nothing else`,
        example: "elderly Indian couple, lush green garden, warm evening light, dignified and peaceful, soft bokeh background, medium shot, photorealistic, Tamil Nadu architecture in background, --ar 16:9 --v 6 --style raw"
      },
      runway: {
        name: "Runway Gen-3",
        syntax: `SYNTAX RULES — RUNWAY GEN-3:
- Write as a film director's shot description — cinematic language only
- MUST include: shot type (close-up/medium/wide), camera movement (static/dolly in/slow pan/handheld), subject action, environment, mood/tone, lighting style
- Reference cinematic styles: "shot on 35mm film", "golden hour cinematography", "soft documentary style"
- Keep it under 150 words — Runway degrades with overly long prompts
- End with a lighting + color grade note
- Output a SINGLE Runway prompt ready to paste`,
        example: "Medium shot, slow dolly forward. An elderly Indian woman sits peacefully on a sunlit veranda, looking into the distance. Warm golden hour light filters through tropical foliage. Soft documentary style, shot on 35mm film. Muted warm tones, gentle grain."
      },
      dalle3: {
        name: "DALL-E 3",
        syntax: `SYNTAX RULES — DALL-E 3:
- Write in clear descriptive prose — full sentences work well
- Describe foreground, midground, and background separately for complex compositions
- Be specific about style: "photorealistic", "editorial photography", "warm cinematic"
- Add: "Do not include any text in the image."
- Be explicit about mood, lighting, and cultural elements
- Output a SINGLE DALL-E 3 prompt ready to paste`,
        example: ""
      },
      stablediffusion: {
        name: "Stable Diffusion",
        syntax: `SYNTAX RULES — STABLE DIFFUSION:
- Use (word:weight) syntax for emphasis — (subject:1.4) boosts that element
- ALWAYS include a negative prompt — output it as a separate block labelled "NEGATIVE PROMPT:"
- Recommended settings note: CFG 7-9, Steps 30-40
- Comma-separated tags, most important first
- Style tags: photorealistic, hyperrealistic, 8k, detailed, cinematic lighting
- Output TWO blocks: POSITIVE PROMPT: and NEGATIVE PROMPT:`,
        example: ""
      },
      kling: {
        name: "Kling AI",
        syntax: `SYNTAX RULES — KLING AI:
- Kling excels at realistic human motion — describe body movement explicitly
- Structure: [subject + action described precisely], [camera angle and shot type], [environment], [mood/lighting], [motion style]
- Be explicit about motion: "walks slowly", "turns head toward camera", "gestures with hands"
- Specify camera: eye-level / low angle / overhead + static or moving
- Keep it focused — one scene, one action, one mood
- Output a SINGLE Kling prompt ready to paste`,
        example: ""
      },
    };

    const tool = TOOL_RULES[pgTool];
    const system = `You are a prompt engineer specialising in visual AI tools. Your job is to analyse a reference image and generate a production-ready prompt for recreating a similar image/video.

${tool.syntax}

CONTEXT ABOUT THE BRAND:
- This is for Elements Senior Living projects in Tamil Nadu, India
- Target audience: Seniors 60+ and their adult children
- Visual tone: dignified, warm, aspirational, peaceful, South Indian cultural context
- Common visual elements: green campuses, sunlit spaces, elderly people in dignified settings, family moments, clean modern architecture with traditional touches

${pgContext ? "USER'S ADDITIONAL DIRECTION:\n" + pgContext + "\n" : ""}

TASK:
1. Analyse the uploaded reference image carefully — note subject, composition, lighting, mood, style, colours, setting
2. Generate a single production-ready prompt for ${tool.name} following the syntax rules above EXACTLY
3. If the tool requires a negative prompt (Stable Diffusion), include it as a separate labelled block

Return ONLY valid JSON:
{"prompt":"the complete ready-to-paste prompt","negative_prompt":"only for SD, else null","notes":"one sentence on what was optimised and why — e.g. what camera angle, style reference, or technique was chosen"}`;

    try {
      const mediaContent = pgFile.isVideo && pgFile.frames
        ? [
            ...pgFile.frames.map(fr => ([
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: fr.b64 } },
              { type: "text", text: `[Frame ${fr.timeIndex}/${pgFile.frames.length} — ${fr.timeLabel}]` },
            ])).flat(),
            { type: "text", text: `Total duration: ~${pgFile.duration ? Math.round(pgFile.duration) : "?"}s. These ${pgFile.frames.length} frames are evenly sampled across the full video. Analyse motion arcs, scene changes, camera movement, pacing, subjects, lighting progression, and mood across all frames to generate the ${tool.name} prompt. JSON only.` },
          ]
        : [
            { type: "image", source: { type: "base64", media_type: normalizeMediaType(pgFile.mediaType), data: pgFile.b64 } },
            { type: "text", text: `Analyse this reference image and generate a ${tool.name} prompt. JSON only.` },
          ];

      const raw = await callClaude(system, [{ role: "user", content: mediaContent }], 1500);
      const parsed = safeJSON(raw);
      setPgResult(parsed);
    } catch(e) {
      setPgError(e.message);
    }
    setPgLoading(false);
  };

  const showToast = (msg, type = "ok") => { setToast({ msg, type }); setTimeout(() => setToast(null), 3200); };

  const saveProjects = (p) => { setProjects(p); try { localStorage.setItem("acg_proj_v1", JSON.stringify(p)); } catch {} };
  const saveHistory  = (h) => { setHistory(h);  try { localStorage.setItem("acg_hist_v1", JSON.stringify(h.slice(0, 60))); } catch {} };

  // ── File upload ────────────────────────────────────────────────────────────
  const handleFiles = useCallback(async (files) => {
    const arr = Array.from(files);
    const added = await Promise.all(arr.map(async f => ({
      id: Math.random().toString(36).slice(2), file: f,
      preview: `data:${f.type || 'image/jpeg'};base64,${await toB64(f)}`,
      mediaType: f.type || "image/jpeg",
      status: "ready", result: null, error: null,
    })));
    setCreatives(p => [...p, ...added]);
  }, []);

  const readyC = creatives.filter(c => c.status === "ready").length;
  const doneC  = creatives.filter(c => c.status === "done").length;

  // ── Generate copy ──────────────────────────────────────────────────────────
  const generate = async () => {
    const ready = creatives.filter(c => c.status === "ready");
    if (!ready.length) return;
    setGenerating(true);
    const p = projects[projKey];
    const best  = insights?.meta?.best  || [];
    const worst = insights?.meta?.worst || [];
    let insCtx = best.length > 0 ? [
      "WHAT IS WORKING — study these patterns:",
      ...best.slice(0, 3).map(a => `[₹${a.cpl} CPL | ${a.ad_name}]\nHeadline: "${a.headline}"\nPrimary Text: "${(a.primary_text || "").slice(0, 250)}"`),
      "", "WHAT IS FAILING — avoid these:",
      ...worst.slice(0, 2).map(a => `[₹${a.cpl} CPL | ${a.ad_name}]\nHeadline: "${a.headline}"\nPrimary Text: "${(a.primary_text || "").slice(0, 150)}"`),
      "", "COPY INTELLIGENCE: " + (insights?.meta?.summary || ""),
    ].join("\n") : "No campaign insights — apply senior living best practices.";

    const system = [
      "You are a senior real estate ad copywriter for Elements Senior Living, Chennai, India.",
      `PROJECT: ${p.name} — ${p.subtitle}`,
      `LOCATION: ${p.location}`,
      `UNITS: ${p.units}`,
      `TAGLINE: ${p.tagline}`,
      `TARGET: ${p.target}`,
      "HIGHLIGHTS:\n" + p.highlights.map(h => "- " + h).join("\n"),
      p.custom_kb ? "ADDITIONAL CONTEXT:\n" + p.custom_kb : "",
      "", insCtx, "",
      "AUDIENCE: Seniors 55–70 and adult children 30–45. South Indian / Tamil Nadu culture, vegetarian, family values. NEVER say 'old age home'.",
      "LANGUAGE: Tamil text/kolam/traditional attire in image = Tamil Unicode. Otherwise English.",
      "TONE: Warm, dignified, aspirational. First line must stop the scroll.",
      "Generate exactly 3 variations with distinct angles.",
      "HARD LIMITS: Meta primary_text max 150 chars | headline max 40 | description max 30. Google RSA: exactly 15 headlines each max 30 chars, 4 descriptions max 90 chars. Google Standard: headline_1/2/3 max 30, description_1/2 max 90.",
      'Return ONLY valid JSON:\n{"language":"English or Tamil","creative_description":"one sentence","variations":[{"id":1,"angle":"label","meta":{"primary_text":"","headline":"","description":""},"google_rsa":{"headlines":["","","","","","","","","","","","","","",""],"descriptions":["","","",""]},"google_standard":{"headline_1":"","headline_2":"","headline_3":"","description_1":"","description_2":""}}]}',
    ].join("\n");

    const cur = [...creatives];
    for (let i = 0; i < cur.length; i++) {
      if (cur[i].status !== "ready") continue;
      cur[i] = { ...cur[i], status: "generating" };
      setCreatives([...cur]);
      try {
        const raw = await callClaude(system, [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: normalizeMediaType(cur[i].mediaType), data: cur[i].preview.split(',')[1] } },
          { type: "text", text: "Analyse this creative and return JSON. JSON only." },
        ]}]);
        const result = safeJSON(raw);
        if (!result.variations?.length) throw new Error("No variations in response");
        cur[i] = { ...cur[i], status: "done", result };
        const entry = { id: Math.random().toString(36).slice(2), projKey, projName: p.name, date: new Date().toISOString(), fileName: cur[i].file.name, preview: cur[i].preview, result };
        saveHistory([entry, ...history]);
      } catch (e) {
        cur[i] = { ...cur[i], status: "error", error: e.message };
      }
      setCreatives([...cur]);
    }
    setGenerating(false);
  };

  // ── Rate creative ──────────────────────────────────────────────────────────
  const rate = async () => {
    if (!rateTarget) return;
    setRatingLoading(true); setRating(null); setRatingError("");
    const { creative, variation } = rateTarget;
    const m = variation.meta || {};
    const copyText = [`Headline: ${m.headline || ""}`, `Primary Text: ${m.primary_text || ""}`, `Description: ${m.description || ""}`].join("\n");
    const p = projects[projKey];
    const bestCpl  = metaCon?.best?.[0]?.cpl;
    const worstCpl = metaCon?.worst?.[0]?.cpl;
    const insCtx   = bestCpl ? `Best CPL in this account: ₹${bestCpl}. Worst: ₹${worstCpl}. Best hook: "${(metaCon.best[0].primary_text || "").slice(0, 120)}"` : "";

    const system = `You are a senior creative strategist specialising in Indian real estate advertising for Tamil Nadu senior living projects.

Rate both the creative image AND the ad copy together across 7 parameters. For each parameter:
- score: integer 1–10
- colour: "green" (8–10), "amber" (5–7), "red" (1–4)
- rationale: 1 specific sentence about what you see in THIS image and copy
- suggestion: specific rewrite/change to improve (only if score < 8, else null)

PARAMETERS:
1. hook_strength — Does the first line/visual stop a Tamil Nadu senior from scrolling? Emotional pull, curiosity, identity.
2. emotional_resonance — Does it evoke dignity, aspiration, peace, family pride for 60+ Indian seniors? Avoid corporate tone.
3. clarity_of_offer — Clear value prop? Price anchor (Rs.X lakhs)? Location named? Specific CTA? Offer prominent?
4. cultural_fit — South Indian/Tamil Nadu values: family respect, vegetarian lifestyle, temple/nature imagery, inter-generational respect?
5. sense_of_urgency — Compelling reason to act now: limited units, time-bound offer, spot booking discount, festive hook?
6. character_limit_compliance — Meta: primary text ideally <150 chars, headline <40 chars, description <30 chars. Penalise heavily if blown.
7. predicted_cpl_tier — Predict CPL tier: score 8–10 = low ₹80–200 (green), 5–7 = medium ₹200–500 (amber), 1–4 = high ₹500+ (red).

Return ONLY valid JSON:
{"overall_score":7,"overall_colour":"amber","overall_summary":"One sentence overall.","parameters":{"hook_strength":{"score":0,"colour":"red","rationale":"","suggestion":null},"emotional_resonance":{"score":0,"colour":"red","rationale":"","suggestion":null},"clarity_of_offer":{"score":0,"colour":"red","rationale":"","suggestion":null},"cultural_fit":{"score":0,"colour":"red","rationale":"","suggestion":null},"sense_of_urgency":{"score":0,"colour":"red","rationale":"","suggestion":null},"character_limit_compliance":{"score":0,"colour":"red","rationale":"","suggestion":null},"predicted_cpl_tier":{"score":0,"colour":"red","rationale":"","suggestion":null}}}`;

    try {
      const raw = await callClaude(system, [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: normalizeMediaType(creative.mediaType), data: creative.preview.split(',')[1] } },
        { type: "text", text: `PROJECT: ${p.name} — ${p.subtitle}\nLOCATION: ${p.location}\n\nAD COPY:\n${copyText}\n\n${insCtx ? "CAMPAIGN CONTEXT: " + insCtx + "\n\n" : ""}Rate this creative. JSON only.` },
      ]}], 2000);
      setRating(safeJSON(raw));
    } catch (e) {
      setRatingError(e.message);
    }
    setRatingLoading(false);
  };

  // ── Insights computed ───────────────────────────────────────────────────────
  const metaCon = repo.meta?.consolidated;
  const googleCon = repo.google?.consolidated;
  const metaEntries = repo.meta?.entries || [];
  const googleEntries = repo.google?.entries || [];
  const lastMetaDate = metaEntries.length ? new Date(metaEntries[metaEntries.length-1].date) : null;
  const lastGoogleDate = googleEntries.length ? new Date(googleEntries[googleEntries.length-1].date) : null;
  const metaAge = lastMetaDate ? Math.floor((Date.now() - lastMetaDate.getTime()) / 86400000) : null;
  const googleAge = lastGoogleDate ? Math.floor((Date.now() - lastGoogleDate.getTime()) / 86400000) : null;
  const metaStale = metaAge !== null && metaAge >= 30;
  const googleStale = googleAge !== null && googleAge >= 30;
  const insights = { meta: metaCon || { best: [], worst: [], summary: "" } };

  const proj = projects[projKey] || projects[Object.keys(projects)[0]] || { name: "No project", subtitle: "Add a project first", location: "", highlights: [], color: "#94A3B8", tagline: "", target: "", units: "", custom_kb: "" };

  // ── RENDER ─────────────────────────────────────────────────────────────────
  const T = { fontFamily: "'DM Sans', system-ui, sans-serif" };

  return (
    <div style={{ ...T, background: "#F8FAFC", minHeight: "100vh" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Serif+Display&display=swap');
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: #CBD5E1; border-radius: 2px; }
        button { font-family: inherit; }
        input, textarea { font-family: inherit; }
      `}</style>

      {/* Toast */}
      {toast && <div style={{ position: "fixed", top: 14, right: 14, zIndex: 999, padding: "9px 16px", borderRadius: 10, fontSize: 12, fontWeight: 600, color: "#fff", background: toast.type === "err" ? "#DC2626" : "#1E293B", boxShadow: "0 4px 16px rgba(0,0,0,.2)", ...T }}>{toast.msg}</div>}

      {/* Header */}
      <div style={{ background: "#0F172A", position: "sticky", top: 0, zIndex: 20 }}>
        <div style={{ maxWidth: 820, margin: "0 auto", padding: "0 18px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "13px 0 3px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontFamily: "'DM Serif Display', serif", fontSize: 17, color: "#F8FAFC" }}>Elements</span>
              <span style={{ width: 1, height: 12, background: "#334155", margin: "0 4px" }} />
              <span style={{ fontSize: 12, color: "#64748B", fontWeight: 500 }}>Ad Copy Gen</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {(metaStale || googleStale) && <span style={{ fontSize: 10, background: "#FEF3C7", color: "#92400E", padding: "2px 8px", borderRadius: 100, fontWeight: 600 }}>Insights {Math.max(metaAge||0, googleAge||0)}d old</span>}
              {!metaStale && !googleStale && metaEntries.length > 0 && <span style={{ fontSize: 10, color: "#475569" }}>Meta {metaAge}d · {metaEntries.length} upload{metaEntries.length>1?"s":""}</span>}
              {metaEntries.length === 0 && googleEntries.length === 0 && <span style={{ fontSize: 10, color: "#475569" }}>No insights yet</span>}
            </div>
          </div>
          <div style={{ display: "flex", gap: 1 }}>
            {[["promptgen", "✦ Prompt Gen"], ["generate", "✦ Ad Copy Gen"], ["social", "✦ Social Copy"], ["projects", "Projects"], ["insights", "Insights"], ["history", "History"]].map(([id, lbl]) => (
              <button key={id} onClick={() => setTab(id)} style={{ background: "none", border: "none", borderBottom: tab === id ? "2px solid #818CF8" : "2px solid transparent", cursor: "pointer", fontSize: 12, fontWeight: 600, padding: "9px 13px", color: tab === id ? "#C7D2FE" : "#64748B", transition: "color .15s" }}>{lbl}</button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 820, margin: "0 auto", padding: "22px 18px" }}>

        {/* ── GENERATE ─────────────────────────────────────────────────────── */}
        {tab === "generate" && (
          <div>
            {Object.keys(projects).length === 0 && (
              <div style={{ background: "#F5F3FF", border: "1px solid #DDD6FE", borderRadius: 14, padding: "11px 14px", marginBottom: 14, fontSize: 12, color: "#6D28D9", cursor: "pointer" }} onClick={() => setTab("projects")}>
                ✦ <strong>No projects yet</strong> — go to the Projects tab to add your first project before generating copy.
              </div>
            )}
            {!metaCon && !googleCon && (
              <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 14, padding: "11px 14px", marginBottom: 14, fontSize: 12, color: "#92400E", cursor: "pointer" }} onClick={() => setTab("insights")}>
                ⚠ <strong>No insights loaded yet</strong> — upload your Meta or Google Ads report in the Insights tab. Copy generation works without it, but insights make the copy significantly better.
              </div>
            )}
            {(metaStale || googleStale) && (
              <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 14, padding: "11px 14px", marginBottom: 14, fontSize: 12, color: "#92400E", cursor: "pointer" }} onClick={() => setTab("insights")}>
                ⚠ <strong>Insights are {Math.max(metaAge || 0, googleAge || 0)}+ days old</strong> — consider uploading a fresh report in the Insights tab.
              </div>
            )}

            {/* Project selector */}
            <div style={{ background: "#fff", border: "1px solid #E2E8F0", borderRadius: 18, padding: "16px 18px", marginBottom: 13 }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 11 }}>Select Project</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                {Object.entries(projects).map(([k, p]) => (
                  <button key={k} onClick={() => setProjKey(k)} style={{ padding: "6px 16px", borderRadius: 100, border: "2px solid " + (projKey === k ? p.color : "#E2E8F0"), background: projKey === k ? p.color + "12" : "#F8FAFC", color: projKey === k ? p.color : "#64748B", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>{p.name}</button>
                ))}
              </div>
              <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 9 }}>{proj.subtitle} · {proj.location}</div>
            </div>

            {/* Dropzone */}
            <div
              onClick={() => fileRef.current?.click()}
              onDragOver={e => { e.preventDefault(); e.currentTarget.style.borderColor = proj.color; }}
              onDragLeave={e => { e.currentTarget.style.borderColor = "#CBD5E1"; }}
              onDrop={e => { e.preventDefault(); e.currentTarget.style.borderColor = "#CBD5E1"; handleFiles(e.dataTransfer.files); }}
              style={{ border: "2px dashed #CBD5E1", borderRadius: 18, padding: "36px 20px", textAlign: "center", cursor: "pointer", background: "#fff", marginBottom: 15, transition: "all .2s" }}>
              <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={e => { handleFiles(e.target.files); e.target.value = ""; }} />
              <div style={{ fontSize: 28, marginBottom: 7 }}>🖼</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#475569" }}>Click or drag to upload ad creatives</div>
              <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 3 }}>PNG, JPG, WEBP — hold Ctrl/Cmd to select multiple</div>
            </div>

            {creatives.length > 0 && (
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 13 }}>
                  <span style={{ fontSize: 12, color: "#64748B" }}>{creatives.length} creative{creatives.length > 1 ? "s" : ""} · {readyC} ready · {doneC} done</span>
                  <div style={{ display: "flex", gap: 9, alignItems: "center" }}>
                    <button onClick={() => setCreatives([])} style={{ fontSize: 11, color: "#94A3B8", background: "none", border: "none", cursor: "pointer" }}>Clear all</button>
                    {readyC > 0 && (
                      <button onClick={generate} disabled={generating} style={{ padding: "8px 20px", borderRadius: 11, background: generating ? "#C4B5FD" : proj.color, color: "#fff", fontWeight: 700, fontSize: 12, border: "none", cursor: generating ? "not-allowed" : "pointer", boxShadow: generating ? "none" : `0 2px 12px ${proj.color}44` }}>
                        {generating ? "Generating…" : `Generate for ${readyC} creative${readyC > 1 ? "s" : ""}`}
                      </button>
                    )}
                  </div>
                </div>

                {creatives.map(c => {
                  const stMap = { ready: ["#F1F5F9", "#64748B", "Ready"], generating: ["#FFFBEB", "#92400E", "Generating…"], done: ["#F0FDF4", "#166534", "Done"], error: ["#FEF2F2", "#991B1B", "Failed"] };
                  const [sbg, sc, sl] = stMap[c.status] || stMap.ready;
                  return (
                    <div key={c.id} style={{ border: "1px solid #E2E8F0", borderRadius: 18, overflow: "hidden", marginBottom: 13, background: "#fff" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "11px 13px", borderBottom: "1px solid #F1F5F9" }}>
                        <img src={c.preview} alt="" style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 9, border: "1px solid #E2E8F0", flexShrink: 0 }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.file.name}</div>
                          <div style={{ fontSize: 10, color: "#94A3B8", marginTop: 2 }}>{(c.file.size / 1024).toFixed(0)} KB</div>
                        </div>
                        <span style={{ fontSize: 10, fontWeight: 700, padding: "3px 9px", borderRadius: 100, background: sbg, color: sc }}>{sl}</span>
                        {c.status === "ready" && <button onClick={() => setCreatives(p => p.filter(x => x.id !== c.id))} style={{ background: "none", border: "none", cursor: "pointer", color: "#CBD5E1", fontSize: 18, lineHeight: 1, padding: 0 }}>×</button>}
                      </div>
                      {c.result?.creative_description && <div style={{ padding: "7px 13px", background: "#F5F3FF", borderBottom: "1px solid #EDE9FE", fontSize: 11, color: "#6D28D9" }}><strong>Detected:</strong> {c.result.creative_description}</div>}
                      {c.status === "error" && <div style={{ padding: "9px 13px", fontSize: 11, color: "#DC2626", fontFamily: "monospace", background: "#FEF2F2" }}>{c.error}</div>}
                      {c.result?.variations && (
                        <div style={{ padding: 13 }}>
                          {c.result.variations.map((v, i) => (
                            <VarCard key={i} v={v} idx={i} onRate={(variation) => { setRateTarget({ creative: c, variation }); setRating(null); setRatingError(""); }} />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* ── INLINE RATING ── */}
            {rateTarget && (
              <div style={{ marginTop: 8 }}>
                <div style={{ background: "#fff", border: "1px solid #E2E8F0", borderRadius: 18, padding: "15px 16px", marginBottom: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 12 }}>
                    <img src={rateTarget.creative.preview} alt="" style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 9, border: "1px solid #E2E8F0" }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 11, color: "#94A3B8", marginBottom: 2 }}>Rating: <strong style={{ color: "#7C3AED" }}>{rateTarget.variation.angle}</strong></div>
                      <div style={{ fontSize: 12, color: "#475569" }}>{rateTarget.variation.meta?.headline}</div>
                    </div>
                    <button onClick={() => { setRateTarget(null); setRating(null); setRatingError(""); }} style={{ background: "none", border: "none", cursor: "pointer", color: "#CBD5E1", fontSize: 18, padding: 0 }}>×</button>
                  </div>
                  <div style={{ display: "flex", gap: 9, alignItems: "center" }}>
                    <button onClick={rate} disabled={ratingLoading} style={{ padding: "8px 20px", borderRadius: 11, background: ratingLoading ? "#FDE68A" : "#0F172A", color: ratingLoading ? "#92400E" : "#F8FAFC", fontWeight: 700, fontSize: 12, border: "none", cursor: ratingLoading ? "not-allowed" : "pointer" }}>
                      {ratingLoading ? "Analysing creative + copy…" : "⭐ Rate This Creative"}
                    </button>
                    {ratingError && <span style={{ fontSize: 11, color: "#DC2626" }}>✗ {ratingError}</span>}
                  </div>
                </div>
                {ratingLoading && (
                  <div style={{ textAlign: "center", padding: "40px 0", color: "#94A3B8" }}>
                    <div style={{ fontSize: 24, marginBottom: 8 }}>⏳</div>
                    <div style={{ fontSize: 12 }}>Analysing image + copy together… (10–15 seconds)</div>
                  </div>
                )}
                {rating && <RatingDisplay rating={rating} creative={rateTarget?.creative} />}
              </div>
            )}
          </div>
        )}

        {/* ── SOCIAL COPY ──────────────────────────────────────────────────── */}
        {tab === "social" && (
          <div>
            <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: 20, color: "#0F172A", marginBottom: 6 }}>Social Media Copy</div>
            <div style={{ fontSize: 12, color: "#64748B", marginBottom: 20, lineHeight: 1.6 }}>Upload a creative image and select the platforms you want copy for. Each platform gets copy written in its own style and format.</div>

            {/* Project selector */}
            <div style={{ background: "#fff", border: "1px solid #E2E8F0", borderRadius: 16, padding: "14px 16px", marginBottom: 14 }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 11 }}>Select Project</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                {Object.entries(projects).map(([k, p]) => (
                  <button key={k} onClick={() => setSmProjKey(k)} style={{ padding: "6px 16px", borderRadius: 100, border: "2px solid " + (smProjKey === k ? p.color : "#E2E8F0"), background: smProjKey === k ? p.color + "12" : "#F8FAFC", color: smProjKey === k ? p.color : "#64748B", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>{p.name}</button>
                ))}
              </div>
              <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 9 }}>{(projects[smProjKey] || projects[Object.keys(projects)[0]]).subtitle} · {(projects[smProjKey] || projects[Object.keys(projects)[0]]).location}</div>
            </div>

            <div style={{ background: "#fff", border: "1px solid #E2E8F0", borderRadius: 16, padding: "14px 16px", marginBottom: 14 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 10 }}>Select Platforms</div>
              <div style={{ display: "flex", gap: 9 }}>
                {[
                  { key: "facebook",  label: "Facebook",  icon: "📘", color: "#1877F2", desc: "Warm & conversational" },
                  { key: "instagram", label: "Instagram", icon: "📸", color: "#E1306C", desc: "Visual & lifestyle" },
                  { key: "linkedin",  label: "LinkedIn",  icon: "💼", color: "#0A66C2", desc: "Professional & insightful" },
                ].map(({ key, label, icon, color, desc }) => {
                  const on = smPlatforms.includes(key);
                  return (
                    <button key={key} onClick={() => setSmPlatforms(p => on ? p.filter(x => x !== key) : [...p, key])}
                      style={{ flex: 1, padding: "10px 8px", borderRadius: 12, border: "2px solid " + (on ? color : "#E2E8F0"), background: on ? color + "10" : "#F8FAFC", cursor: "pointer", textAlign: "center" }}>
                      <div style={{ fontSize: 20, marginBottom: 4 }}>{icon}</div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: on ? color : "#475569" }}>{label}</div>
                      <div style={{ fontSize: 10, color: on ? color + "BB" : "#94A3B8", marginTop: 2 }}>{desc}</div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={{ background: "#fff", border: "1px solid #E2E8F0", borderRadius: 16, padding: "14px 16px", marginBottom: 14 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 10 }}>Creative Image or Video</div>
              {!smFile ? (
                <div onClick={() => document.getElementById("sm-file-input").click()}
                  style={{ border: "2px dashed #CBD5E1", borderRadius: 12, padding: "32px 20px", textAlign: "center", cursor: "pointer", background: "#F8FAFC" }}>
                  <input type="file" id="sm-file-input" accept="image/*,video/*" style={{ display: "none" }} onChange={async e => {
                    const f = e.target.files[0]; if (!f) return;
                    const isVideo = f.type.startsWith("video/");
                    if (isVideo) {
                      setSmFile({ preview: null, frames: null, b64: null, mediaType: "image/jpeg", name: f.name, isVideo: true, loading: true });
                      setSmResult(null); setSmError("");
                      try {
                        const { frames } = await extractVideoFrames(f, 8);
                        setSmFile({ preview: frames[0].dataUrl, frames, b64: frames[0].b64, mediaType: "image/jpeg", name: f.name, isVideo: true, loading: false });
                      } catch(err) {
                        setSmError("Could not process video: " + err.message);
                        setSmFile(null);
                      }
                    } else {
                      const b64 = await toB64(f);
                      const rawType = f.type.toLowerCase();
                      const mediaType = rawType.includes("png") ? "image/png" : rawType.includes("gif") ? "image/gif" : rawType.includes("webp") ? "image/webp" : "image/jpeg";
                      setSmFile({ preview: `data:${f.type};base64,${b64}`, frames: null, b64, mediaType, name: f.name, isVideo: false, loading: false });
                      setSmResult(null); setSmError("");
                    }
                    e.target.value = "";
                  }} />
                  <div style={{ fontSize: 28, marginBottom: 7 }}>🖼</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#475569" }}>Click to upload image or video</div>
                  <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 3 }}>PNG, JPG, WEBP, MP4, MOV</div>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                  {smFile.loading ? (
                    <div style={{ width: 72, height: 72, borderRadius: 10, border: "1px solid #E2E8F0", background: "#F8FAFC", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, flexShrink: 0 }}>
                      <span style={{ fontSize: 18 }}>⏳</span>
                      <span style={{ fontSize: 9, color: "#94A3B8" }}>Uploading…</span>
                    </div>
                  ) : smFile.isVideo && smFile.frames ? (
                    <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
                      {smFile.frames.slice(0, 4).map((fr, i) => (
                        <div key={i} style={{ position: "relative" }}>
                          <img src={fr.dataUrl} alt="" style={{ width: 32, height: 32, objectFit: "cover", borderRadius: 4, border: "1px solid #E2E8F0", display: "block" }} />
                          <span style={{ position: "absolute", bottom: 1, left: 1, fontSize: 6, fontWeight: 700, background: "rgba(0,0,0,.6)", color: "#fff", padding: "1px 2px", borderRadius: 2 }}>{fr.timeLabel}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <img src={smFile.preview} alt="" style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 10, border: "1px solid #E2E8F0", flexShrink: 0 }} />
                  )}
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "#1E293B" }}>{smFile.name}</div>
                    <button onClick={() => { setSmFile(null); setSmResult(null); setSmError(""); }}
                      style={{ fontSize: 11, color: "#94A3B8", background: "none", border: "none", cursor: "pointer", padding: 0, marginTop: 4 }}>× Remove</button>
                  </div>
                </div>
              )}
            </div>

            <div style={{ background: "#fff", border: "1px solid #E2E8F0", borderRadius: 16, padding: "14px 16px", marginBottom: 14 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 8 }}>Additional Direction <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>(optional)</span></div>
              <input value={smContext} onChange={e => setSmContext(e.target.value)}
                placeholder='e.g. "focus on Grihapravesam offer", "highlight the green campus", "target adult children"'
                style={{ width: "100%", fontSize: 12, border: "1px solid #E2E8F0", borderRadius: 9, padding: "8px 12px", outline: "none", color: "#1E293B", background: "#F8FAFC" }} />
            </div>

            <button onClick={generateSocialCopy} disabled={!smFile || !smPlatforms.length || smLoading}
              style={{ width: "100%", padding: "12px", borderRadius: 12, background: !smFile || !smPlatforms.length || smLoading ? "#E2E8F0" : "#0F172A", color: !smFile || !smPlatforms.length || smLoading ? "#94A3B8" : "#F8FAFC", fontWeight: 700, fontSize: 13, border: "none", cursor: !smFile || !smPlatforms.length || smLoading ? "not-allowed" : "pointer", marginBottom: 20 }}>
              {smLoading ? "⏳ Writing copy for " + smPlatforms.length + " platform" + (smPlatforms.length > 1 ? "s" : "") + "…" : "✦ Generate Social Copy"}
            </button>

            {smError && <div style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 12, padding: "11px 14px", fontSize: 12, color: "#DC2626", marginBottom: 14 }}>✗ {smError}</div>}

            {smResult && (
              <div>
                {[
                  { key: "facebook",  label: "Facebook",  icon: "📘", color: "#1877F2", bg: "#EFF6FF", border: "#BFDBFE" },
                  { key: "instagram", label: "Instagram", icon: "📸", color: "#E1306C", bg: "#FDF2F8", border: "#FBCFE8" },
                  { key: "linkedin",  label: "LinkedIn",  icon: "💼", color: "#0A66C2", bg: "#EFF6FF", border: "#BFDBFE" },
                ].filter(p => smResult[p.key]).map(({ key, label, icon, color, bg, border }) => {
                  const d = smResult[key];
                  const full = d.copy + (d.hashtags ? "\n\n" + d.hashtags : "");
                  return (
                    <div key={key} style={{ background: "#fff", border: "1px solid " + border, borderRadius: 18, overflow: "hidden", marginBottom: 14 }}>
                      <div style={{ background: bg, padding: "11px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid " + border }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                          <span style={{ fontSize: 16 }}>{icon}</span>
                          <span style={{ fontSize: 13, fontWeight: 700, color }}>{label}</span>
                        </div>
                        <CopyBtn text={full} />
                      </div>
                      <div style={{ padding: "14px 16px" }}>
                        <div style={{ fontSize: 13, color: "#1E293B", lineHeight: 1.7, whiteSpace: "pre-wrap", marginBottom: d.hashtags ? 12 : 0 }}>{d.copy}</div>
                        {d.hashtags && (
                          <div style={{ fontSize: 12, color: color, lineHeight: 1.8, fontWeight: 500 }}>{d.hashtags}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
                <button onClick={generateSocialCopy}
                  style={{ width: "100%", padding: "9px", borderRadius: 10, border: "1px solid #E2E8F0", background: "transparent", color: "#64748B", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>↺ Regenerate</button>
              </div>
            )}
          </div>
        )}

        {/* ── PROMPT GEN ───────────────────────────────────────────────────── */}
        {tab === "promptgen" && (
          <div>
            <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: 20, color: "#0F172A", marginBottom: 6 }}>Prompt Gen</div>
            <div style={{ fontSize: 12, color: "#64748B", marginBottom: 20, lineHeight: 1.6 }}>Upload a reference image and get a production-ready prompt to recreate a similar visual on your chosen AI tool. Each prompt follows the exact syntax rules for that tool.</div>

            <div style={{ background: "#fff", border: "1px solid #E2E8F0", borderRadius: 16, padding: "14px 16px", marginBottom: 14 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 10 }}>Target Tool</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                {[
                  { key: "midjourney",       label: "Midjourney",         icon: "🎨", color: "#5865F2" },
                  { key: "runway",           label: "Runway Gen-3",       icon: "🎬", color: "#E11D48" },
                  { key: "dalle3",           label: "DALL-E 3",           icon: "🤖", color: "#10B981" },
                  { key: "stablediffusion",  label: "Stable Diffusion",   icon: "⚡", color: "#F59E0B" },
                  { key: "kling",            label: "Kling AI",           icon: "🎥", color: "#8B5CF6" },
                ].map(({ key, label, icon, color }) => (
                  <button key={key} onClick={() => { setPgTool(key); setPgResult(null); }} style={{ padding: "7px 16px", borderRadius: 100, border: "2px solid " + (pgTool === key ? color : "#E2E8F0"), background: pgTool === key ? color + "12" : "#F8FAFC", color: pgTool === key ? color : "#64748B", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>
                    {icon} {label}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 9 }}>
                {pgTool === "midjourney" && "Comma-separated descriptors · Subject first · Parameters at end (--ar --v 6 --style raw)"}
                {pgTool === "runway" && "Cinematic shot description · Camera movement · Shot type · Film style reference"}
                {pgTool === "dalle3" && "Descriptive prose · Foreground / midground / background · No text in image"}
                {pgTool === "stablediffusion" && "(word:weight) syntax · Positive + Negative prompt blocks · CFG 7-9"}
                {pgTool === "kling" && "Subject action + camera angle + environment · Human motion described explicitly"}
              </div>
            </div>

            <div style={{ background: "#fff", border: "1px solid #E2E8F0", borderRadius: 16, padding: "14px 16px", marginBottom: 14 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 10 }}>Reference Image</div>
              {!pgFile ? (
                <div
                  onClick={() => document.getElementById("pg-file-input").click()}
                  style={{ border: "2px dashed #CBD5E1", borderRadius: 12, padding: "32px 20px", textAlign: "center", cursor: "pointer", background: "#F8FAFC" }}>
                  <input type="file" id="pg-file-input" accept="image/*,video/*" style={{ display: "none" }} onChange={async e => {
                    const f = e.target.files[0]; if (!f) return;
                    const isVideo = f.type.startsWith("video/");
                    try {
                      if (isVideo) {
                        setPgError(""); setPgResult(null);
                        setPgFile({ preview: null, frames: null, b64: null, mediaType: "image/jpeg", name: f.name, isVideo: true, loading: true, loadingMsg: "Uploading to server…" });
                        const { frames, duration } = await extractVideoFrames(f, 8);
                        setPgFile({ preview: frames[0].dataUrl, frames, b64: frames[0].b64, mediaType: "image/jpeg", name: f.name, isVideo: true, duration, loading: false });
                      } else {
                        const b64 = await toB64(f);
                        setPgFile({ preview: `data:${f.type};base64,${b64}`, frames: null, b64, mediaType: f.type || "image/jpeg", name: f.name, isVideo: false, loading: false });
                      }
                    } catch(err) {
                      setPgError("Could not process file: " + err.message);
                      setPgFile(null);
                    }
                    e.target.value = "";
                  }} />
                  <div style={{ fontSize: 28, marginBottom: 7 }}>🖼</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#475569" }}>Click to upload reference image or video</div>
                  <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 3 }}>PNG, JPG, WEBP, MP4, MOV, WEBM</div>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                  <div style={{ flexShrink: 0 }}>
                    {pgFile.loading ? (
                      <div style={{ width: 80, height: 80, borderRadius: 10, border: "1px solid #E2E8F0", background: "#F8FAFC", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4 }}>
                        <span style={{ fontSize: 18 }}>⏳</span>
                        <span style={{ fontSize: 9, color: "#94A3B8", textAlign: "center", lineHeight: 1.3 }}>{pgFile.loadingMsg || "Processing…"}</span>
                      </div>
                    ) : pgFile.isVideo && pgFile.frames ? (
                      <div>
                        <div style={{ display: "flex", gap: 3, marginBottom: 4 }}>
                          {pgFile.frames.slice(0, 4).map((fr, i) => (
                            <div key={i} style={{ position: "relative" }}>
                              <img src={fr.dataUrl} alt="" style={{ width: 36, height: 36, objectFit: "cover", borderRadius: 5, border: "1px solid #E2E8F0", display: "block" }} />
                              <span style={{ position: "absolute", bottom: 1, left: 1, fontSize: 7, fontWeight: 700, background: "rgba(0,0,0,.6)", color: "#fff", padding: "1px 3px", borderRadius: 3 }}>{fr.timeLabel}</span>
                            </div>
                          ))}
                        </div>
                        <div style={{ display: "flex", gap: 3 }}>
                          {pgFile.frames.slice(4).map((fr, i) => (
                            <div key={i} style={{ position: "relative" }}>
                              <img src={fr.dataUrl} alt="" style={{ width: 36, height: 36, objectFit: "cover", borderRadius: 5, border: "1px solid #E2E8F0", display: "block" }} />
                              <span style={{ position: "absolute", bottom: 1, left: 1, fontSize: 7, fontWeight: 700, background: "rgba(0,0,0,.6)", color: "#fff", padding: "1px 3px", borderRadius: 3 }}>{fr.timeLabel}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <img src={pgFile.preview} alt="" style={{ width: 80, height: 80, objectFit: "cover", borderRadius: 10, border: "1px solid #E2E8F0" }} />
                    )}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "#1E293B", marginBottom: 4 }}>{pgFile.name}</div>
                    <button onClick={() => { setPgFile(null); setPgResult(null); setPgError(""); }} style={{ fontSize: 11, color: "#94A3B8", background: "none", border: "none", cursor: "pointer", padding: 0 }}>× Remove</button>
                  </div>
                </div>
              )}
            </div>

            <div style={{ background: "#fff", border: "1px solid #E2E8F0", borderRadius: 16, padding: "14px 16px", marginBottom: 14 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 8 }}>Additional Direction <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>(optional)</span></div>
              <input
                value={pgContext}
                onChange={e => setPgContext(e.target.value)}
                placeholder='e.g. "make it more warm and golden hour", "add Tamil Nadu architecture", "more emotional, focus on family"'
                style={{ width: "100%", fontSize: 12, border: "1px solid #E2E8F0", borderRadius: 9, padding: "8px 12px", outline: "none", color: "#1E293B", background: "#F8FAFC" }}
              />
            </div>

            <button
              onClick={generatePrompt}
              disabled={!pgFile || pgLoading}
              style={{ width: "100%", padding: "12px", borderRadius: 12, background: !pgFile || pgLoading ? "#E2E8F0" : "#0F172A", color: !pgFile || pgLoading ? "#94A3B8" : "#F8FAFC", fontWeight: 700, fontSize: 13, border: "none", cursor: !pgFile || pgLoading ? "not-allowed" : "pointer", marginBottom: 20 }}>
              {pgLoading ? "⏳ Analysing image and generating prompt…" : "✦ Generate Prompt"}
            </button>

            {pgError && (
              <div style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 12, padding: "11px 14px", fontSize: 12, color: "#DC2626", marginBottom: 14 }}>✗ {pgError}</div>
            )}

            {pgResult && (
              <div>
                <div style={{ background: "#0F172A", borderRadius: 18, padding: 20, marginBottom: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: ".07em" }}>
                      {pgTool === "stablediffusion" ? "Positive Prompt" : "Generated Prompt"} · {{"midjourney":"Midjourney v6","runway":"Runway Gen-3","dalle3":"DALL-E 3","stablediffusion":"Stable Diffusion","kling":"Kling AI"}[pgTool] || pgTool}
                    </div>
                    <CopyBtn text={pgResult.prompt || ""} />
                  </div>
                  <div style={{ fontSize: 13, color: "#F8FAFC", lineHeight: 1.75, fontFamily: pgTool === "midjourney" || pgTool === "stablediffusion" ? "monospace" : "inherit", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                    {pgResult.prompt}
                  </div>
                </div>

                {pgResult.negative_prompt && (
                  <div style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 14, padding: "14px 16px", marginBottom: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "#DC2626", textTransform: "uppercase", letterSpacing: ".07em" }}>Negative Prompt</div>
                      <CopyBtn text={pgResult.negative_prompt} />
                    </div>
                    <div style={{ fontSize: 12, color: "#7F1D1D", fontFamily: "monospace", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{pgResult.negative_prompt}</div>
                  </div>
                )}

                {pgResult.notes && (
                  <div style={{ background: "#F5F3FF", border: "1px solid #DDD6FE", borderRadius: 12, padding: "10px 14px", fontSize: 12, color: "#4C1D95" }}>
                    💡 {pgResult.notes}
                  </div>
                )}

                <button onClick={generatePrompt} style={{ width: "100%", marginTop: 12, padding: "9px", borderRadius: 10, border: "1px solid #E2E8F0", background: "transparent", color: "#64748B", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>↺ Regenerate</button>
              </div>
            )}
          </div>
        )}

        {/* ── HISTORY ──────────────────────────────────────────────────────── */}
        {tab === "history" && (
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
              <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: 20, color: "#0F172A" }}>Copy History</div>
              {history.length > 0 && <button onClick={() => saveHistory([])} style={{ fontSize: 11, color: "#EF4444", background: "none", border: "none", cursor: "pointer" }}>Clear all</button>}
            </div>
            {!history.length ? (
              <div style={{ textAlign: "center", padding: "70px 0", color: "#94A3B8" }}><div style={{ fontSize: 36, marginBottom: 10 }}>📋</div><div style={{ fontSize: 13 }}>No history yet.</div></div>
            ) : history.map(entry => (
              <div key={entry.id} style={{ background: "#fff", border: "1px solid #E2E8F0", borderRadius: 18, overflow: "hidden", marginBottom: 13 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "11px 13px", borderBottom: "1px solid #F1F5F9" }}>
                  {entry.preview && <img src={entry.preview} alt="" style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 8, border: "1px solid #E2E8F0", flexShrink: 0 }} />}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.fileName}</div>
                    <div style={{ display: "flex", gap: 8, marginTop: 3, alignItems: "center" }}>
                      <span style={{ fontSize: 10, fontWeight: 700, color: projects[entry.projKey]?.color || "#7C3AED" }}>{entry.projName}</span>
                      <span style={{ fontSize: 10, color: "#94A3B8" }}>{new Date(entry.date).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</span>
                    </div>
                  </div>
                </div>
                <div style={{ padding: 13 }}>
                  {(entry.result?.variations || []).map((v, i) => <VarCard key={i} v={v} idx={i} />)}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── PROJECTS ─────────────────────────────────────────────────────── */}
        {tab === "projects" && (
          <div>
            <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: 20, color: "#0F172A", marginBottom: 18 }}>Project Knowledge Base</div>
            {Object.entries(projects).map(([k, p]) => (
              <div key={k} style={{ background: "#fff", border: "1px solid #E2E8F0", borderRadius: 18, padding: "16px 18px", marginBottom: 11 }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 11 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 3 }}>
                      <span style={{ width: 9, height: 9, borderRadius: "50%", background: p.color || "#94A3B8", display: "inline-block" }} />
                      <span style={{ fontSize: 14, fontWeight: 700, color: "#0F172A" }}>{p.name}</span>
                      {BASE_PROJECTS[k] && <span style={{ fontSize: 9, background: "#F1F5F9", color: "#94A3B8", padding: "2px 6px", borderRadius: 4, fontWeight: 700 }}>BUILT-IN</span>}
                      {p.custom_kb && <span style={{ fontSize: 9, background: "#DCFCE7", color: "#166534", padding: "2px 6px", borderRadius: 4, fontWeight: 700 }}>KB LOADED</span>}
                    </div>
                    <div style={{ fontSize: 11, color: "#94A3B8" }}>{p.subtitle} · {p.location}</div>
                  </div>
                  {!BASE_PROJECTS[k] && (
                    <button onClick={() => { if (window.confirm("Remove " + p.name + "?")) { const n = { ...projects }; delete n[k]; saveProjects(n); if (projKey === k) setProjKey(Object.keys(n)[0]); }}} style={{ background: "none", border: "none", cursor: "pointer", color: "#CBD5E1", fontSize: 18, padding: 0 }}>×</button>
                  )}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 11 }}>
                  {(p.highlights || []).slice(0, 5).map((h, i) => <span key={i} style={{ fontSize: 10, background: "#F1F5F9", color: "#475569", padding: "3px 9px", borderRadius: 100 }}>{h.length > 55 ? h.slice(0, 53) + "…" : h}</span>)}
                  {(p.highlights || []).length > 5 && <span style={{ fontSize: 10, color: "#94A3B8", padding: "3px 5px" }}>+{p.highlights.length - 5} more</span>}
                </div>
                {p.tagline && <div style={{ fontSize: 11, fontStyle: "italic", color: p.color || "#7C3AED", marginTop: 9 }}>"{p.tagline}"</div>}
              </div>
            ))}

            <div style={{ background: "#fff", border: "2px dashed #CBD5E1", borderRadius: 18, padding: "16px 18px" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#0F172A", marginBottom: 13 }}>Add New Project</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                {[["Project Name *", npName, setNpName, "Elements Kaveri"], ["Subtitle", npSub, setNpSub, "Senior Living, Mysuru"], ["Location", npLoc, setNpLoc, "Mysuru, Karnataka"], ["Units", npUnits, setNpUnits, "2BHK from ₹99L"]].map(([lbl, val, set, ph]) => (
                  <div key={lbl}>
                    <div style={{ fontSize: 9, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 5 }}>{lbl}</div>
                    <input value={val} onChange={e => set(e.target.value)} placeholder={ph} style={{ width: "100%", fontSize: 12, border: "1px solid #E2E8F0", borderRadius: 9, padding: "8px 12px", outline: "none", color: "#1E293B" }} />
                  </div>
                ))}
              </div>
              {[["Tagline", npTag, setNpTag, "Your golden years, beautifully lived"], ["Target Audience", npTgt, setNpTgt, "Seniors 60+, Mysuru and Bangalore"]].map(([lbl, val, set, ph]) => (
                <div key={lbl} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 5 }}>{lbl}</div>
                  <input value={val} onChange={e => set(e.target.value)} placeholder={ph} style={{ width: "100%", fontSize: 12, border: "1px solid #E2E8F0", borderRadius: 9, padding: "8px 12px", outline: "none", color: "#1E293B" }} />
                </div>
              ))}
              <div style={{ marginBottom: 13 }}>
                <div style={{ fontSize: 9, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 5 }}>Key Highlights (one per line)</div>
                <textarea value={npHl} onChange={e => setNpHl(e.target.value)} placeholder={"Premium senior-friendly apartments\n24/7 medical assistance\nNear hospital and airport"} style={{ width: "100%", fontSize: 12, border: "1px solid #E2E8F0", borderRadius: 9, padding: "8px 12px", outline: "none", color: "#1E293B", minHeight: 80, resize: "vertical" }} />
              </div>
              <button onClick={() => {
                if (!npName.trim()) { showToast("Project name required", "err"); return; }
                const key = npName.toLowerCase().replace(/[^a-z0-9]+/g, "_") + "_" + Date.now();
                const n = { ...projects, [key]: { name: npName, subtitle: npSub, location: npLoc, units: npUnits, tagline: npTag, target: npTgt, highlights: npHl.split("\n").map(x => x.trim()).filter(Boolean), color: "#6B7280", custom_kb: "" } };
                saveProjects(n);
                setNpName(""); setNpSub(""); setNpLoc(""); setNpUnits(""); setNpTag(""); setNpTgt(""); setNpHl("");
                showToast(npName + " added ✓");
              }} style={{ padding: "8px 18px", borderRadius: 9, background: "#0F172A", color: "#F8FAFC", fontWeight: 600, fontSize: 12, border: "none", cursor: "pointer" }}>Add Project</button>
            </div>
          </div>
        )}

        {/* ── INSIGHTS ─────────────────────────────────────────────────────── */}
        {tab === "insights" && (
          <div>
            <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: 20, color: "#0F172A", marginBottom: 16 }}>Insights Repository</div>
            <div style={{ fontSize: 12, color: "#64748B", marginBottom: 20, lineHeight: 1.6 }}>
              Upload your ads reports to build a living knowledge base. Each upload adds new learnings on top of previous ones — the tool automatically merges insights across all uploads and keeps a running consolidated view.
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }}>
              {[
                { key: "meta", label: "Meta Ads", icon: "📘", color: "#1877F2", status: metaStatus, entries: metaEntries, con: metaCon, age: metaAge, stale: metaStale },
                { key: "google", label: "Google Ads", icon: "🔍", color: "#4285F4", status: googleStatus, entries: googleEntries, con: googleCon, age: googleAge, stale: googleStale },
              ].map(({ key, label, icon, color, status, entries, con, age, stale }) => (
                <div key={key} style={{ background: "#fff", border: "1px solid #E2E8F0", borderRadius: 16, padding: "14px 16px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 10 }}>
                    <span style={{ fontSize: 16 }}>{icon}</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: "#0F172A" }}>{label}</span>
                    {entries.length > 0 && (
                      <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 100, background: stale ? "#FEF3C7" : "#DCFCE7", color: stale ? "#92400E" : "#166534", marginLeft: "auto" }}>
                        {entries.length} upload{entries.length > 1 ? "s" : ""} · {age}d ago
                      </span>
                    )}
                  </div>
                  {con ? (
                    <div style={{ fontSize: 11, color: "#475569", marginBottom: 10, lineHeight: 1.5 }}>
                      <strong>{con.best?.length || 0}</strong> top ads · <strong>{con.worst?.length || 0}</strong> underperformers · <strong>{con.entry_count}</strong> upload{con.entry_count > 1 ? "s" : ""} merged
                    </div>
                  ) : (
                    <div style={{ fontSize: 11, color: "#94A3B8", marginBottom: 10 }}>No data yet — upload your first report</div>
                  )}
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 600, padding: "6px 12px", borderRadius: 8, border: "1px solid " + color + "40", color, cursor: "pointer", background: color + "08", width: "fit-content" }}>
                    📂 Upload Report
                    <input type="file" accept=".xlsx,.xls,.csv" style={{ display: "none" }} onChange={e => { if (e.target.files[0]) { processReport(e.target.files[0], key); e.target.value = ""; }}} />
                  </label>
                  {status.msg && (
                    <div style={{ fontSize: 11, color: status.error ? "#DC2626" : status.loading ? "#D97706" : "#059669", marginTop: 8, lineHeight: 1.4 }}>
                      {status.loading ? "⏳ " : status.error ? "✗ " : "✓ "}{status.msg}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {(metaEntries.length > 0 || googleEntries.length > 0) && (
              <div style={{ background: "#fff", border: "1px solid #E2E8F0", borderRadius: 16, padding: "14px 16px", marginBottom: 20 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 12 }}>Upload History</div>
                {[...metaEntries.map(e => ({ ...e, platform: "meta" })), ...googleEntries.map(e => ({ ...e, platform: "google" }))]
                  .sort((a, b) => new Date(b.date) - new Date(a.date))
                  .map((e, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, paddingBottom: 10, marginBottom: 10, borderBottom: i < metaEntries.length + googleEntries.length - 2 ? "1px solid #F1F5F9" : "none" }}>
                      <span style={{ fontSize: 14, flexShrink: 0 }}>{e.platform === "meta" ? "📘" : "🔍"}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: "#1E293B" }}>{e.source}</div>
                        <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 2 }}>{new Date(e.date).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })} · {e.best?.length || 0} top + {e.worst?.length || 0} weak ads</div>
                        <div style={{ fontSize: 11, color: "#475569", marginTop: 4, lineHeight: 1.5 }}>{e.summary?.slice(0, 120)}{(e.summary?.length || 0) > 120 ? "…" : ""}</div>
                      </div>
                      <button onClick={() => {
                        const updated = JSON.parse(JSON.stringify(repo));
                        updated[e.platform].entries = updated[e.platform].entries.filter(x => x.date !== e.date || x.source !== e.source);
                        updated[e.platform].consolidated = updated[e.platform].entries.length ? buildConsolidated(updated[e.platform].entries) : null;
                        saveRepo(updated); setRepo(updated);
                        showToast("Entry removed");
                      }} style={{ background: "none", border: "none", cursor: "pointer", color: "#CBD5E1", fontSize: 16, padding: 0, flexShrink: 0 }}>×</button>
                    </div>
                  ))}
              </div>
            )}

            {metaCon && (
              <div>
                <div style={{ background: "#0F172A", borderRadius: 18, padding: 18, marginBottom: 18 }}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 8 }}>📘 Meta — Consolidated Copy Intelligence</div>
                  <p style={{ fontSize: 13, color: "#F8FAFC", lineHeight: 1.7, margin: 0 }}>{metaCon.summary}</p>
                  <div style={{ fontSize: 10, color: "#334155", marginTop: 10 }}>{metaEntries.length} upload{metaEntries.length > 1 ? "s" : ""} merged · {metaCon.best?.length} top ads · last updated {new Date(metaCon.last_updated).toLocaleDateString("en-IN")}</div>
                </div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#059669", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 10 }}>✅ All-time top performers</div>
                {(metaCon.best || []).map((ad, i) => (
                  <div key={i} style={{ background: "#fff", border: "1px solid #BBF7D0", borderRadius: 13, padding: "11px 13px", marginBottom: 9 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8, gap: 11 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 10, color: "#94A3B8", fontWeight: 600, marginBottom: 3 }}>{ad.ad_name}{ad.campaign_name ? " · " + ad.campaign_name : ""}</div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "#1E293B" }}>{ad.headline || "—"}</div>
                      </div>
                      <div style={{ textAlign: "right", flexShrink: 0 }}>
                        <div style={{ fontSize: 20, fontWeight: 700, color: "#16A34A" }}>₹{ad.cpl}</div>
                        <div style={{ fontSize: 9, color: "#94A3B8" }}>{ad.conversions} leads</div>
                      </div>
                    </div>
                    {ad.primary_text && <div style={{ fontSize: 11, color: "#374151", background: "#F0FDF4", borderRadius: 8, padding: "7px 10px", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{ad.primary_text.slice(0, 260)}{ad.primary_text.length > 260 ? "…" : ""}</div>}
                  </div>
                ))}
                <div style={{ fontSize: 11, fontWeight: 700, color: "#DC2626", textTransform: "uppercase", letterSpacing: ".06em", margin: "20px 0 10px" }}>⚠ All-time underperformers</div>
                {(metaCon.worst || []).map((ad, i) => (
                  <div key={i} style={{ background: "#fff", border: "1px solid #FECACA", borderRadius: 13, padding: "11px 13px", marginBottom: 9 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8, gap: 11 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 10, color: "#94A3B8", fontWeight: 600, marginBottom: 3 }}>{ad.ad_name}{ad.campaign_name ? " · " + ad.campaign_name : ""}</div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "#1E293B" }}>{ad.headline || "—"}</div>
                      </div>
                      <div style={{ textAlign: "right", flexShrink: 0 }}>
                        <div style={{ fontSize: 20, fontWeight: 700, color: "#DC2626" }}>₹{ad.cpl}</div>
                        <div style={{ fontSize: 9, color: "#94A3B8" }}>{ad.conversions} leads</div>
                      </div>
                    </div>
                    {ad.primary_text && <div style={{ fontSize: 11, color: "#374151", background: "#FEF2F2", borderRadius: 8, padding: "7px 10px", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{ad.primary_text.slice(0, 260)}{ad.primary_text.length > 260 ? "…" : ""}</div>}
                  </div>
                ))}
              </div>
            )}

            {googleCon && (
              <div style={{ marginTop: 24 }}>
                <div style={{ background: "#1E3A5F", borderRadius: 18, padding: 18, marginBottom: 18 }}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 8 }}>🔍 Google Ads — Consolidated Intelligence</div>
                  <p style={{ fontSize: 13, color: "#F8FAFC", lineHeight: 1.7, margin: 0 }}>{googleCon.summary}</p>
                  <div style={{ fontSize: 10, color: "#334155", marginTop: 10 }}>{googleEntries.length} upload{googleEntries.length > 1 ? "s" : ""} merged · {googleCon.best?.length} top ads · last updated {new Date(googleCon.last_updated).toLocaleDateString("en-IN")}</div>
                </div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#059669", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 10 }}>✅ Top Google Ads</div>
                {(googleCon.best || []).map((ad, i) => (
                  <div key={i} style={{ background: "#fff", border: "1px solid #BFDBFE", borderRadius: 13, padding: "11px 13px", marginBottom: 9 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8, gap: 11 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 10, color: "#94A3B8", fontWeight: 600, marginBottom: 3 }}>{ad.ad_name}{ad.campaign_name ? " · " + ad.campaign_name : ""}</div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "#1E293B" }}>{ad.headline || "—"}</div>
                      </div>
                      <div style={{ textAlign: "right", flexShrink: 0 }}>
                        <div style={{ fontSize: 20, fontWeight: 700, color: "#1D4ED8" }}>₹{ad.cpl}</div>
                        <div style={{ fontSize: 9, color: "#94A3B8" }}>{ad.conversions} conv.</div>
                      </div>
                    </div>
                    {ad.description && <div style={{ fontSize: 11, color: "#374151", background: "#EFF6FF", borderRadius: 8, padding: "7px 10px", lineHeight: 1.55 }}>{ad.description}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
