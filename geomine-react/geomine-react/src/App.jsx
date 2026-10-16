import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { sb, BUCKET } from "./supabase";

/* ---------- Helpers ---------- */
const pct = (c) => (c == null ? "?" : Math.round(c * 100) + "%");
const EMAIL_RE = /^\S+@\S+\.\S+$/;
const nice = (s) => (s || "").replace(/_/g, " ");
const sentence = (s) => {
  const t = nice(s);
  return t.charAt(0).toUpperCase() + t.slice(1);
};
const fmtDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
const fmtSize = (n) => (n < 1048576 ? Math.max(1, Math.round(n / 1024)) + " KB" : (n / 1048576).toFixed(1) + " MB");

const friendly = (m = "") => {
  if (/invalid login/i.test(m)) return "The email or password is incorrect.";
  if (/not confirmed/i.test(m))
    return "Your email is not confirmed yet. Open the confirmation link we emailed you, then sign in.";
  if (/rate limit|too many/i.test(m)) return "Too many attempts. Wait a few minutes and try again.";
  if (/already registered/i.test(m)) return "An account with this email already exists. Sign in instead.";
  return m;
};

/* ---------- Small shared pieces ---------- */
function Logo({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2 21 8.5 17.5 21h-11L3 8.5z" fill="currentColor" opacity=".25" />
      <path d="M12 2 21 8.5 12 12 3 8.5z" fill="currentColor" />
      <path d="M12 12 17.5 21h-11z" fill="currentColor" opacity=".6" />
    </svg>
  );
}

function Field({ label, required, hint, error, children }) {
  return (
    <label className="field">
      <span className="lbl">
        {label}
        {required && (
          <>
            <span className="req" aria-hidden="true"> *</span>
            <span className="sr"> (required)</span>
          </>
        )}
      </span>
      {children}
      {error ? <span className="ferr" role="alert">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

function Badge({ tone = "neutral", children }) {
  return <span className={"badge " + tone}>{children}</span>;
}

function Tile({ value, label, loading }) {
  return (
    <div className="tile" aria-busy={loading ? "true" : undefined}>
      <div className="tile-n">{loading ? <Sk w={56} h={30} /> : value}</div>
      <div className="tile-l">{label}</div>
    </div>
  );
}

/* ---------- Loading skeletons ---------- */
function Sk({ w = "100%", h = 14, r }) {
  return <span className="sk" style={{ width: w, height: h, borderRadius: r }} aria-hidden="true" />;
}

function SkRows({ cols, rows = 3 }) {
  const widths = ["62%", "38%", "50%", "30%", "44%", "56%"];
  return Array.from({ length: rows }, (_, i) => (
    <tr key={i} aria-hidden="true">
      {Array.from({ length: cols }, (_, j) => (
        <td key={j}><Sk w={widths[(i + j) % widths.length]} /></td>
      ))}
    </tr>
  ));
}

function SkTable({ heads, rows = 4 }) {
  return (
    <div className="table-wrap" aria-busy="true">
      <span className="sr" role="status">Loading</span>
      <table>
        <thead><tr>{heads.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
        <tbody><SkRows cols={heads.length} rows={rows} /></tbody>
      </table>
    </div>
  );
}

function SkGrid({ n = 3 }) {
  return (
    <div className="grid" aria-busy="true">
      <span className="sr" role="status">Loading datasets</span>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="dtile skel" aria-hidden="true">
          <span className="dtile-top"><Sk w={62} h={20} r={999} /><Sk w={70} h={12} /></span>
          <Sk w="70%" h={18} />
          <Sk w="55%" h={12} />
          <Sk w="80%" h={12} />
        </div>
      ))}
    </div>
  );
}

function PageSkeleton() {
  return (
    <div aria-busy="true">
      <span className="sr" role="status">Loading</span>
      <div className="pagehead">
        <Sk w="34%" h={30} />
        <div style={{ height: 10 }} />
        <Sk w="46%" h={14} />
      </div>
      <div className="tiles">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="tile" aria-hidden="true">
            <Sk w={56} h={30} />
            <div style={{ height: 8 }} />
            <Sk w="60%" h={12} />
          </div>
        ))}
      </div>
      <SkGrid />
    </div>
  );
}

function Toast({ msg, onClose }) {
  if (!msg.text) return null;
  return (
    <div className={"toast " + (msg.bad ? "bad" : msg.busy ? "busy" : "ok")} role={msg.bad ? "alert" : "status"}>
      {msg.busy && <span className="spin" aria-hidden="true" />}
      <span>{msg.text}</span>
      <button className="x" onClick={onClose} aria-label="Dismiss message">&times;</button>
    </div>
  );
}

function ConfirmDialog({ title, children, confirmLabel = "Delete", busy, onConfirm, onCancel }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && !busy) onCancel(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy]);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
        <h2 id="dlg-title">{title}</h2>
        <div className="dlg-body">{children}</div>
        <div className="row end">
          <button className="btn ghost" autoFocus onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="btn danger" onClick={onConfirm} disabled={busy}>{busy ? "Deleting…" : confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

/* ---------- App shell ---------- */
export default function App() {
  const [user, setUser] = useState(undefined); // undefined = still checking
  const [org, setOrg] = useState(undefined); // undefined = loading, null = none yet
  const [ds, setDs] = useState(null);
  const [msg, setMsg] = useState({ text: "", bad: false, busy: false });
  const note = (text, bad = false, busy = false) => setMsg({ text, bad, busy });

  // Success messages fade out by themselves; errors and in-progress messages stay.
  useEffect(() => {
    if (!msg.text || msg.bad || msg.busy) return;
    const t = setTimeout(() => setMsg({ text: "", bad: false, busy: false }), 6000);
    return () => clearTimeout(t);
  }, [msg]);

  useEffect(() => {
    const { data } = sb.auth.onAuthStateChange((_e, s) => setUser(s?.user ?? null));
    return () => data.subscription.unsubscribe();
  }, []);

  const loadOrg = async () => {
    const { data, error } = await sb.from("memberships").select("role, organizations(id,name)").eq("user_id", user.id);
    if (error) return note(error.message, true);
    setOrg(data.length ? data[0].organizations : null);
  };
  useEffect(() => {
    if (user) loadOrg();
    else { setOrg(undefined); setDs(null); }
  }, [user]);

  if (user === undefined) {
    return (
      <>
        <header className="topbar">
          <div className="brand"><Logo /><span>GeoMine</span></div>
        </header>
        <main className="page"><PageSkeleton /></main>
      </>
    );
  }
  if (!user) return <Auth />;

  let body;
  if (org === undefined) body = <PageSkeleton />;
  else if (org === null) body = <OrgSetup note={note} onDone={loadOrg} />;
  else if (ds) body = <DatasetView ds={ds} user={user} note={note} onBack={() => setDs(null)} />;
  else body = <Datasets org={org} user={user} note={note} onOpen={setDs} />;

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <Logo />
          <span>GeoMine</span>
          {org && <span className="orgchip">{org.name}</span>}
        </div>
        <div className="who">
          <span className="email">{user.email}</span>
          <button className="btn ghost light sm" onClick={() => sb.auth.signOut()}>Sign out</button>
        </div>
      </header>
      <main className="page">{body}</main>
      <Toast msg={msg} onClose={() => note("")} />
    </>
  );
}

/* ---------- Sign in / create account ---------- */
function Auth() {
  const [mode, setMode] = useState("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [sentTo, setSentTo] = useState(null);
  const [resent, setResent] = useState("");

  const emailErr = !email.trim()
    ? "Enter your email address."
    : !EMAIL_RE.test(email.trim())
    ? "Enter a valid email address, for example name@example.com."
    : "";
  const passErr = !password
    ? "Enter your password."
    : mode === "up" && password.length < 6
    ? "Use at least 6 characters."
    : "";

  const switchMode = (m) => {
    setMode(m);
    setErr("");
    setTried(false);
  };

  const submit = async (e) => {
    e.preventDefault();
    setTried(true);
    setErr("");
    if (emailErr || passErr) return;
    setBusy(true);
    const creds = { email: email.trim(), password };
    if (mode === "in") {
      const { error } = await sb.auth.signInWithPassword(creds);
      if (error) setErr(friendly(error.message));
    } else {
      const { data, error } = await sb.auth.signUp({ ...creds, options: { emailRedirectTo: window.location.origin } });
      if (error) setErr(friendly(error.message));
      else if (data.user && data.user.identities && data.user.identities.length === 0)
        setErr("An account with this email already exists. Sign in instead.");
      else if (!data.session) setSentTo(creds.email);
      // If a session came back, email confirmation is off and the app signs the user in automatically.
    }
    setBusy(false);
  };

  const resend = async () => {
    setResent("");
    const { error } = await sb.auth.resend({ type: "signup", email: sentTo });
    setResent(error ? friendly(error.message) : "Confirmation email sent again.");
  };

  return (
    <div className="auth">
      <aside className="auth-side">
        <div className="brand light">
          <Logo size={26} />
          <span>GeoMine</span>
        </div>
        <div className="auth-pitch">
          <h2>Turn geological archives into reviewed mineral data</h2>
          <p>
            Upload reports, maps and borehole logs. GeoMine extracts the mineral occurrences and flags every uncertain
            value for a geologist to check.
          </p>
          <ul className="pitch-list">
            <li><b>Upload</b> scanned or digital documents with their licence details.</li>
            <li><b>Extract</b> mineral occurrences with a confidence score on each field.</li>
            <li><b>Review</b> low-confidence values against the original page.</li>
          </ul>
        </div>
      </aside>

      <section className="auth-main">
        <div className="auth-card">
          {sentTo ? (
            <>
              <div className="mail-ic" aria-hidden="true">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <path d="m3 7 9 6 9-6" />
                </svg>
              </div>
              <h1>Check your email</h1>
              <p>
                We sent a confirmation link to <b>{sentTo}</b>. Open it to activate your account, then come back here
                and sign in.
              </p>
              <ul className="tips">
                <li>The email can take a few minutes to arrive.</li>
                <li>Check your spam or junk folder.</li>
                <li>You cannot sign in until the email is confirmed.</li>
              </ul>
              <div className="row">
                <button
                  className="btn"
                  onClick={() => {
                    setSentTo(null);
                    switchMode("in");
                    setPassword("");
                  }}
                >
                  Go to sign in
                </button>
                <button className="btn ghost" onClick={resend}>Resend email</button>
              </div>
              {resent && <p className="hint" role="status">{resent}</p>}
            </>
          ) : (
            <>
              <h1>{mode === "in" ? "Sign in to GeoMine" : "Create your account"}</h1>
              <p className="mut">
                {mode === "in"
                  ? "Use the email and password you registered with."
                  : "We will email you a link to confirm your address before you can sign in."}
              </p>

              <div className="seg" role="tablist" aria-label="Account">
                <button role="tab" aria-selected={mode === "in"} className={mode === "in" ? "on" : ""} onClick={() => switchMode("in")}>
                  Sign in
                </button>
                <button role="tab" aria-selected={mode === "up"} className={mode === "up" ? "on" : ""} onClick={() => switchMode("up")}>
                  Create account
                </button>
              </div>

              <form noValidate onSubmit={submit}>
                {err && <div className="alert bad" role="alert">{err}</div>}
                <Field label="Email" required error={tried && emailErr}>
                  <input
                    type="email"
                    autoComplete="email"
                    placeholder="name@example.com"
                    className={tried && emailErr ? "invalid" : ""}
                    aria-required="true"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </Field>
                <Field label="Password" required error={tried && passErr} hint={mode === "up" ? "At least 6 characters." : ""}>
                  <span className="pw">
                    <input
                      type={show ? "text" : "password"}
                      autoComplete={mode === "in" ? "current-password" : "new-password"}
                      className={tried && passErr ? "invalid" : ""}
                      aria-required="true"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                    <button type="button" className="pwtoggle" onClick={() => setShow(!show)}>
                      {show ? "Hide" : "Show"}
                    </button>
                  </span>
                </Field>
                <button className="btn block" type="submit" disabled={busy}>
                  {busy ? (mode === "in" ? "Signing in…" : "Creating account…") : mode === "in" ? "Sign in" : "Create account"}
                </button>
                <p className="reqnote"><span className="req">*</span> Required field</p>
              </form>
            </>
          )}
        </div>
      </section>
    </div>
  );
}

/* ---------- Organization ---------- */
const KINDS = [
  ["junior_explorer", "Junior explorer", "Early-stage exploration company"],
  ["university", "University", "Teaching or research institution"],
  ["government", "Government", "Geological survey or public agency"],
  ["other", "Other", "Any other organization"],
];

function OrgSetup({ note, onDone }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("junior_explorer");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const nameErr = !name.trim() ? "Enter a name for your organization." : "";

  const create = async (e) => {
    e.preventDefault();
    setTried(true);
    if (nameErr) return;
    setBusy(true);
    const { error } = await sb.rpc("create_organization", { p_name: name.trim(), p_kind: kind });
    setBusy(false);
    if (error) return note(error.message, true);
    note("");
    onDone();
  };

  return (
    <div className="setup">
      <h1>Set up your organization</h1>
      <p className="mut">Datasets belong to an organization. You become its owner.</p>
      <form className="panel" noValidate onSubmit={create}>
        <Field label="Organization name" required error={tried && nameErr}>
          <input
            className={tried && nameErr ? "invalid" : ""}
            aria-required="true"
            placeholder="e.g. Copperbelt Exploration Ltd"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <div className="field">
          <span className="lbl" id="kind-label">
            Organization type<span className="req" aria-hidden="true"> *</span>
          </span>
          <div className="opts" role="radiogroup" aria-labelledby="kind-label">
            {KINDS.map(([v, t, d]) => (
              <label key={v} className="opt">
                <input type="radio" name="kind" value={v} checked={kind === v} onChange={() => setKind(v)} />
                <span className="opt-t">{t}</span>
                <span className="opt-d">{d}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="row between">
          <span className="reqnote"><span className="req">*</span> Required field</span>
          <button className="btn" type="submit" disabled={busy}>{busy ? "Creating…" : "Create organization"}</button>
        </div>
      </form>
    </div>
  );
}

/* ---------- Deleting ---------- */
// Removes the stored files first (the storage rules need the dataset to still exist), then the dataset.
// Its documents and records are removed with it.
async function deleteDataset(d, note) {
  const { data: files } = await sb.storage.from(BUCKET).list(d.id, { limit: 1000 });
  if (files && files.length) await sb.storage.from(BUCKET).remove(files.map((f) => `${d.id}/${f.name}`));
  const { data, error } = await sb.from("datasets").delete().eq("id", d.id).select("id");
  if (error) { note(error.message, true); return false; }
  if (!data || !data.length) { note("The dataset could not be deleted. Check that you have permission to edit it.", true); return false; }
  return true;
}

// Removes the records extracted from a document, its stored file, and the document itself.
async function deleteDocument(d, note) {
  const occ = await sb.from("mineral_occurrences").delete().eq("document_id", d.id).select("id");
  if (occ.error) { note(occ.error.message, true); return false; }
  await sb.storage.from(BUCKET).remove([d.storage_path]);
  const { data, error } = await sb.from("source_documents").delete().eq("id", d.id).select("id");
  if (error) { note(error.message, true); return false; }
  if (!data || !data.length) { note("The document could not be deleted. Check that you have permission to edit this dataset.", true); return false; }
  return true;
}

/* ---------- Datasets ---------- */
function Datasets({ org, user, note, onOpen }) {
  const [list, setList] = useState(null);
  const [docCount, setDocCount] = useState(undefined);
  const blank = { name: "", visibility: "private", source_name: "", licence_terms: "", licence_ref: "", redistribution_allowed: false };
  const [f, setF] = useState(blank);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [toDelete, setToDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const nameErr = !f.name.trim() ? "Enter a name for the dataset." : "";

  const load = async () => {
    const { data, error } = await sb.from("datasets").select("*").eq("owner_org_id", org.id).order("created_at", { ascending: false });
    if (error) note(error.message, true);
    setList(data || []);
  };
  useEffect(() => { load(); }, [org.id]);

  // Document total for the summary tiles (ignored if it fails)
  useEffect(() => {
    if (!list) return;
    if (!list.length) { setDocCount(0); return; }
    sb.from("source_documents")
      .select("id", { count: "exact", head: true })
      .in("dataset_id", list.map((d) => d.id))
      .then(({ count, error }) => setDocCount(error ? null : count));
  }, [list]);

  const create = async (e) => {
    e.preventDefault();
    setTried(true);
    if (nameErr) return;
    setSaving(true);
    const row = { ...f, name: f.name.trim(), owner_org_id: org.id, created_by: user.id };
    for (const k of ["source_name", "licence_terms", "licence_ref"]) row[k] = row[k] || null;
    const { error } = await sb.from("datasets").insert(row);
    setSaving(false);
    if (error) return note(error.message, true);
    note("Dataset created.");
    setF(blank);
    setTried(false);
    setOpen(false);
    load();
  };

  const shared = (list || []).filter((d) => d.visibility === "shared").length;

  const remove = async () => {
    setDeleting(true);
    const ok = await deleteDataset(toDelete, note);
    setDeleting(false);
    if (ok) { setToDelete(null); note("Dataset deleted."); load(); }
  };

  return (
    <>
      <div className="pagehead">
        <h1>{org.name}</h1>
        <p className="mut">Your organization's datasets and their source documents.</p>
      </div>

      <div className="tiles">
        <Tile loading={list === null} value={list ? list.length : "–"} label="Datasets" />
        <Tile loading={list === null} value={list ? list.length - shared : "–"} label="Private" />
        <Tile loading={list === null} value={list ? shared : "–"} label="Shared" />
        <Tile loading={list === null || docCount === undefined} value={docCount ?? "–"} label="Source documents" />
      </div>

      <section>
        <h2>Datasets</h2>
        {list === null ? (
          <SkGrid />
        ) : list.length === 0 ? (
          <div className="empty">
            <h3>No datasets yet</h3>
            <p className="mut">Create your first dataset below. Each dataset holds documents from one source and licence.</p>
          </div>
        ) : (
          <div className="grid">
            {list.map((d) => (
              <article key={d.id} className="dtile">
                <button className="dtile-main" onClick={() => onOpen(d)}>
                  <span className="dtile-top">
                    <Badge tone={d.visibility === "shared" ? "info" : "neutral"}>{d.visibility === "shared" ? "Shared" : "Private"}</Badge>
                    <span className="mut">{fmtDate(d.created_at)}</span>
                  </span>
                  <span className="dtile-name">{d.name}</span>
                  <span className="dtile-meta">{d.source_name ? "Source: " + d.source_name : "No source recorded"}</span>
                  <span className="dtile-meta">{d.licence_terms ? "Licence: " + d.licence_terms : "No licence terms recorded"}</span>
                </button>
                <div className="dtile-foot">
                  <button className="link inline danger" onClick={() => setToDelete(d)}>Delete</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="create">
        <button
          type="button"
          className={"create-toggle" + (open ? " open" : "")}
          aria-expanded={open}
          aria-controls="new-dataset"
          onClick={() => setOpen(!open)}
        >
          <span className="plus" aria-hidden="true">{open ? "\u2212" : "+"}</span>
          <span>Create new dataset</span>
          <svg className="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>

        {open && (
          <form id="new-dataset" className="panel create-form" noValidate onSubmit={create}>
            <div className="two">
              <div>
                <Field label="Dataset name" required error={tried && nameErr}>
                  <input
                    autoFocus
                    className={tried && nameErr ? "invalid" : ""}
                    aria-required="true"
                    placeholder="e.g. Kitwe geological reports"
                    value={f.name}
                    onChange={set("name")}
                  />
                </Field>
                <Field label="Visibility" required hint={f.visibility === "shared" ? "Readable by all signed-in users." : "Only members of your organization can read it."}>
                  <select value={f.visibility} onChange={set("visibility")}>
                    <option value="private">Private</option>
                    <option value="shared">Shared</option>
                  </select>
                </Field>
              </div>
              <fieldset>
                <legend>Source and licence</legend>
                <Field label="Source">
                  <input placeholder="e.g. GSD Digital Store" value={f.source_name} onChange={set("source_name")} />
                </Field>
                <Field label="Licence terms">
                  <input value={f.licence_terms} onChange={set("licence_terms")} />
                </Field>
                <Field label="Licence or purchase reference">
                  <input value={f.licence_ref} onChange={set("licence_ref")} />
                </Field>
                <label className="check">
                  <input type="checkbox" checked={f.redistribution_allowed} onChange={set("redistribution_allowed")} />
                  <span>Licence allows redistribution of the original files</span>
                </label>
              </fieldset>
            </div>
            <div className="row between">
              <span className="reqnote"><span className="req">*</span> Required field</span>
              <span className="row">
                <button type="button" className="btn ghost" onClick={() => { setOpen(false); setTried(false); }}>Cancel</button>
                <button className="btn" type="submit" disabled={saving}>{saving ? "Creating…" : "Create dataset"}</button>
              </span>
            </div>
          </form>
        )}
      </section>

      {toDelete && (
        <ConfirmDialog title={`Delete "${toDelete.name}"?`} busy={deleting} onConfirm={remove} onCancel={() => setToDelete(null)}>
          <p>This permanently deletes the dataset, all of its documents and every record extracted from them. This cannot be undone.</p>
        </ConfirmDialog>
      )}
    </>
  );
}

/* ---------- One dataset: documents, upload, review ---------- */
function DatasetView({ ds, user, note, onBack }) {
  const [docs, setDocs] = useState([]);
  const [busy, setBusy] = useState(null);
  const [tab, setTab] = useState("documents");
  const [pending, setPending] = useState(null);
  const [docsReady, setDocsReady] = useState(false);
  const [delDoc, setDelDoc] = useState(null);
  const [delDs, setDelDs] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const loadDocs = async () => {
    const { data } = await sb.from("source_documents").select("*").eq("dataset_id", ds.id).order("uploaded_at", { ascending: false });
    setDocs(data || []);
    setDocsReady(true);
  };
  useEffect(() => { loadDocs(); }, [ds.id]);

  const extract = async (id) => {
    setBusy(id);
    note("Extraction can take a minute or two.", false, true);
    const { data, error } = await sb.functions.invoke("extract-document", { body: { document_id: id } });
    if (error) {
      let m = error.message;
      try {
        const t = await error.context.text();
        try { const b = JSON.parse(t); m = b.error || b.message || t || m; } catch { m = t || m; }
      } catch { /* keep default message */ }
      if (error.context && error.context.status) m += " (HTTP " + error.context.status + ")";
      note(m, true);
    } else note(`Done: ${data.records} records found, ${data.flagged} flagged for checking.`);
    setBusy(null);
    loadDocs();
  };

  const removeDoc = async () => {
    setDeleting(true);
    const ok = await deleteDocument(delDoc, note);
    setDeleting(false);
    if (ok) { setDelDoc(null); note("Document deleted."); loadDocs(); }
  };
  const removeDs = async () => {
    setDeleting(true);
    const ok = await deleteDataset(ds, note);
    setDeleting(false);
    if (ok) { note("Dataset deleted."); onBack(); }
  };

  const extracted = docs.filter((d) => d.status === "extracted").length;
  const tabs = [["documents", "Documents"], ["upload", "Upload"], ["review", "Review queue"], ["records", "Records"]];
  const tone = (s) => (s === "extracted" ? "ok" : /fail|error/i.test(s || "") ? "bad" : "neutral");

  return (
    <>
      <button className="link" onClick={onBack}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m15 18-6-6 6-6" />
        </svg>
        Back to datasets
      </button>

      <div className="pagehead ph-row">
        <div>
          <h1>{ds.name}</h1>
          <div className="meta-row">
            <Badge tone={ds.visibility === "shared" ? "info" : "neutral"}>{ds.visibility === "shared" ? "Shared" : "Private"}</Badge>
            {ds.source_name && <span>Source: <b>{ds.source_name}</b></span>}
            {ds.licence_terms && <span>Licence: {ds.licence_terms}</span>}
            {ds.licence_ref && <span>Reference: {ds.licence_ref}</span>}
            <Badge tone={ds.redistribution_allowed ? "ok" : "neutral"}>
              {ds.redistribution_allowed ? "Original files can be redistributed" : "Original files not for redistribution"}
            </Badge>
          </div>
        </div>
        <button className="btn ghost danger sm" onClick={() => setDelDs(true)}>Delete dataset</button>
      </div>

      <div className="tiles">
        <Tile loading={!docsReady} value={docs.length} label="Documents" />
        <Tile loading={!docsReady} value={extracted} label="Extracted" />
        <Tile loading={!docsReady} value={docs.length - extracted} label="Awaiting extraction" />
        <Tile loading={pending === null} value={pending >= 60 ? "60+" : pending} label="Fields to review" />
      </div>

      <div className="tabs" role="tablist">
        {tabs.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={"tab" + (tab === k ? " on" : "")} onClick={() => setTab(k)}>
            {l}
            {k === "review" && pending > 0 && <span className="count">{pending >= 60 ? "60+" : pending}</span>}
          </button>
        ))}
      </div>

      <div hidden={tab !== "documents"}>
        <div className="panel flush">
          {!docsReady ? (
            <SkTable heads={["Title", "Type", "Status", ""]} />
          ) : docs.length === 0 ? (
            <div className="empty">
              <h3>No documents yet</h3>
              <p className="mut">Upload a report, map or borehole log to start extracting mineral occurrences.</p>
              <button className="btn" onClick={() => setTab("upload")}>Upload a document</button>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Title</th><th>Type</th><th>Status</th><th></th></tr>
                </thead>
                <tbody>
                  {docs.map((d) => (
                    <tr key={d.id}>
                      <td><b>{d.title}</b></td>
                      <td>{sentence(d.doc_type)}</td>
                      <td><Badge tone={tone(d.status)}>{sentence(d.status)}</Badge></td>
                      <td className="right nowrap">
                        {d.status !== "extracted" && (
                          <>
                            <button className="btn sm" disabled={busy === d.id} onClick={() => extract(d.id)}>
                              {busy === d.id ? "Extracting…" : "Extract data"}
                            </button>{" "}
                          </>
                        )}
                        <button className="btn ghost danger sm" disabled={busy === d.id} onClick={() => setDelDoc(d)}>Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div hidden={tab !== "upload"}>
        <UploadForm
          ds={ds}
          user={user}
          note={note}
          onDone={() => { loadDocs(); setTab("documents"); }}
        />
      </div>

      <div hidden={tab !== "review"}>
        <Review docs={docs} ready={docsReady} user={user} note={note} onCount={setPending} />
      </div>

      <div hidden={tab !== "records"}>
        <Records ds={ds} docs={docs} active={tab === "records"} note={note} onGoDocuments={() => setTab("documents")} />
      </div>

      {delDoc && (
        <ConfirmDialog title={`Delete "${delDoc.title}"?`} busy={deleting} onConfirm={removeDoc} onCancel={() => setDelDoc(null)}>
          <p>This permanently deletes the file and any records extracted from it. This cannot be undone.</p>
        </ConfirmDialog>
      )}
      {delDs && (
        <ConfirmDialog title={`Delete "${ds.name}"?`} busy={deleting} onConfirm={removeDs} onCancel={() => setDelDs(false)}>
          <p>This permanently deletes the dataset, all of its documents and every record extracted from them. This cannot be undone.</p>
        </ConfirmDialog>
      )}
    </>
  );
}

/* ---------- Upload ---------- */
const DOC_TYPES = ["report", "map", "borehole_log", "assay_sheet", "field_notebook", "table", "other"];

function UploadForm({ ds, user, note, onDone }) {
  const [file, setFile] = useState(null);
  const blank = { title: "", doc_type: "report", author: "", year: "", ref: "" };
  const [f, setF] = useState(blank);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const thisYear = new Date().getFullYear();
  const fileErr = !file ? "Choose a PDF or image to upload." : file.size > 18 * 1024 * 1024 ? "This file is over 18 MB. Split it first." : "";
  const yearErr = f.year && !(/^\d{4}$/.test(f.year.trim()) && +f.year <= thisYear) ? "Enter a 4-digit year, for example 1987." : "";

  const upload = async (e) => {
    e.preventDefault();
    setTried(true);
    if (fileErr || yearErr) return;
    setSaving(true);
    note("Uploading…", false, true);
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const path = `${ds.id}/${hash}.${file.name.split(".").pop().toLowerCase()}`;
    const up = await sb.storage.from(BUCKET).upload(path, file);
    if (up.error && !/exist/i.test(up.error.message)) {
      setSaving(false);
      return note("Upload failed: " + up.error.message, true);
    }
    const { error } = await sb.from("source_documents").insert({
      dataset_id: ds.id, title: f.title.trim() || file.name, doc_type: f.doc_type, storage_path: path, sha256: hash,
      original_author: f.author || null, original_year: parseInt(f.year) || null, original_ref: f.ref || null, uploaded_by: user.id,
    });
    setSaving(false);
    if (error) return note(/duplicate/i.test(error.message) ? "This file is already in the dataset." : error.message, true);
    note("Document uploaded. You can now extract its data.");
    setF(blank);
    setFile(null);
    setTried(false);
    onDone();
  };

  return (
    <form className="panel" noValidate onSubmit={upload}>
      <h2>Upload a document</h2>
      <div className="two">
        <div className="field">
          <span className="lbl" id="file-label">
            Document file<span className="req" aria-hidden="true"> *</span>
            <span className="sr"> (required)</span>
          </span>
          <label
            className={"drop" + (tried && fileErr ? " invalid" : "")}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const dropped = e.dataTransfer.files[0];
              if (dropped) setFile(dropped);
            }}
          >
            <input type="file" accept=".pdf,.png,.jpg,.jpeg" aria-labelledby="file-label" onChange={(e) => setFile(e.target.files[0] || null)} />
            {file ? (
              <>
                <b>{file.name}</b>
                <span className="mut">{fmtSize(file.size)}. Select to choose a different file.</span>
              </>
            ) : (
              <>
                <b>Choose a file or drop it here</b>
                <span className="mut">PDF, PNG or JPG, up to 18 MB</span>
              </>
            )}
          </label>
          {tried && fileErr && <span className="ferr" role="alert">{fileErr}</span>}
        </div>

        <div>
          <Field label="Title" hint="Defaults to the file name.">
            <input value={f.title} onChange={set("title")} />
          </Field>
          <Field label="Document type" required>
            <select value={f.doc_type} onChange={set("doc_type")}>
              {DOC_TYPES.map((x) => <option key={x} value={x}>{sentence(x)}</option>)}
            </select>
          </Field>
        </div>
      </div>

      <fieldset>
        <legend>Original publication</legend>
        <div className="three">
          <Field label="Author">
            <input value={f.author} onChange={set("author")} />
          </Field>
          <Field label="Year" error={tried && yearErr}>
            <input inputMode="numeric" maxLength="4" className={tried && yearErr ? "invalid" : ""} value={f.year} onChange={set("year")} />
          </Field>
          <Field label="Archive or report reference">
            <input value={f.ref} onChange={set("ref")} />
          </Field>
        </div>
      </fieldset>

      <div className="row between">
        <span className="reqnote"><span className="req">*</span> Required field</span>
        <button className="btn" type="submit" disabled={saving}>{saving ? "Uploading…" : "Upload document"}</button>
      </div>
    </form>
  );
}

/* ---------- Review queue ---------- */
function Review({ docs, ready, user, note, onCount }) {
  const [rows, setRows] = useState(null);
  const [vals, setVals] = useState({});
  const [done, setDone] = useState({}); // field id -> decision made in this session
  const [working, setWorking] = useState(null);

  const load = async () => {
    if (!ready) return;
    const ids = docs.map((d) => d.id);
    if (!ids.length) { setRows([]); onCount(0); return; }
    const { data, error } = await sb.from("review_queue").select("*").in("document_id", ids)
      .order("confidence", { ascending: true, nullsFirst: true }).limit(60);
    if (error) return note(error.message, true);
    setRows(data);
    onCount(data.length);
    setVals(Object.fromEntries(data.map((r) => [r.id, r.extracted_value ?? ""])));
    setDone({});
  };
  useEffect(() => { load(); }, [docs, ready]);

  const openPage = async (docId, page) => {
    const d = docs.find((x) => x.id === docId);
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(d.storage_path, 300);
    if (error) return note(error.message, true);
    window.open(`${data.signedUrl}#page=${page}`, "_blank");
  };

  const decide = async (r, action) => {
    if (working) return;
    const val = (vals[r.id] ?? "").trim();
    let status = action, corrected = null;
    if (action === "confirm") {
      if (val !== (r.extracted_value ?? "").trim()) { status = "corrected"; corrected = val; } else status = "accepted";
    }
    setWorking(r.id);
    try {
      if (status === "corrected" && !(await applyFix(r.record_id, r.field_name, val, note))) return;
      const { data, error } = await sb.from("extracted_fields").update({
        review: status, corrected_value: corrected, reviewed_by: user.id, reviewed_at: new Date().toISOString(),
      }).eq("id", r.id).select("id");
      if (error) return note(error.message, true);
      if (!data || data.length === 0) return note("This decision could not be saved. Check that you have permission to edit this dataset, then try again.", true);
      await finishRecord(r.record_id);
      const next = { ...done, [r.id]: status };
      setDone(next);
      onCount(rows.length - Object.keys(next).length);
      note(status === "accepted" ? "Value confirmed." : status === "corrected" ? "Correction saved." : "Value rejected.");
    } finally {
      setWorking(null);
    }
  };

  const doneCount = Object.keys(done).length;
  const clearDone = () => { setRows(rows.filter((r) => !done[r.id])); setDone({}); };

  return (
    <div className="panel flush">
      <div className="panel-head">
        <div className="row between">
          <h2>Review queue</h2>
          {doneCount > 0 && <button className="btn ghost sm" onClick={clearDone}>Clear {doneCount} completed</button>}
        </div>
        <p className="mut">
          Lowest confidence first. Edit a value if it is wrong, then confirm it. A record shows as Confirmed on the Records tab once
          all of its fields have been reviewed. Showing up to 60 fields.
        </p>
      </div>
      {rows === null ? (
        <SkTable heads={["Field", "Extracted value", "Confidence", "Source", ""]} />
      ) : rows.length === 0 ? (
        <div className="empty">
          <h3>Nothing waiting for review</h3>
          <p className="mut">Extract a document and any uncertain values will appear here.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Field</th><th>Extracted value</th><th>Confidence</th><th>Source</th><th></th></tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const state = done[r.id];
                const edited = (vals[r.id] ?? "").trim() !== (r.extracted_value ?? "").trim();
                const low = (r.confidence ?? 0) < 0.6;
                const saving = working === r.id;
                return (
                  <tr key={r.id} className={state ? "done" : ""}>
                    <td>{sentence(r.field_name)}</td>
                    <td>
                      <input
                        className="full"
                        aria-label={"Value for " + nice(r.field_name)}
                        disabled={!!state || saving}
                        value={vals[r.id] ?? ""}
                        onChange={(e) => setVals({ ...vals, [r.id]: e.target.value })}
                      />
                    </td>
                    <td>
                      <span className={"conf" + (low ? " low" : "")}>
                        <span className="bar"><i style={{ width: Math.round((r.confidence ?? 0) * 100) + "%" }} /></span>
                        {pct(r.confidence)}
                      </span>
                    </td>
                    <td>
                      <button className="link inline" onClick={() => openPage(r.document_id, r.page_number || 1)}>
                        Page {r.page_number || "?"}
                      </button>
                    </td>
                    <td className="right nowrap">
                      {state ? (
                        <Badge tone={state === "rejected" ? "bad" : "ok"}>
                          {state === "accepted" ? "Confirmed" : state === "corrected" ? "Correction saved" : "Rejected"}
                        </Badge>
                      ) : (
                        <>
                          <button className="btn sm" disabled={saving} onClick={() => decide(r, "confirm")}>
                            {saving ? "Saving…" : edited ? "Save correction" : "Confirm"}
                          </button>{" "}
                          <button className="btn ghost sm" disabled={saving} onClick={() => decide(r, "rejected")}>Reject</button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Writes a human correction back to the record itself
async function applyFix(recordId, field, val, note) {
  const patch = {};
  if (field === "name" || field === "deposit_type") patch[field] = val || null;
  else if (field === "commodities") patch.commodities = val.replace(/[[\]"]/g, "").split(",").map((s) => s.trim()).filter(Boolean);
  else if (field === "location") {
    const m = val.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
    const lat = m && +m[1], lon = m && +m[2];
    if (!m || lat > -8.2 || lat < -18.1 || lon < 21.9 || lon > 33.7) {
      note('Location must be "latitude, longitude" inside Zambia, e.g. -12.8, 28.2', true);
      return false;
    }
    patch.location = `SRID=4326;POINT(${lon} ${lat})`;
  }
  const { data, error } = await sb.from("mineral_occurrences").update(patch).eq("id", recordId).select("id");
  if (error) { note(error.message, true); return false; }
  if (!data || data.length === 0) { note("The correction could not be saved. Check that you have permission to edit this dataset.", true); return false; }
  return true;
}

// Once every field of a record is decided, mark the record itself as reviewed
async function finishRecord(recordId) {
  const { data } = await sb.from("extracted_fields").select("review").eq("record_id", recordId);
  if (!data || data.some((f) => f.review === "pending")) return;
  const r = data.map((f) => f.review);
  const status = r.every((x) => x === "rejected") ? "rejected" : r.includes("corrected") || r.includes("rejected") ? "corrected" : "accepted";
  await sb.from("mineral_occurrences").update({ record_review: status }).eq("id", recordId);
}

/* ---------- Records: search, map and export ---------- */
const STATUS_LABEL = { accepted: "Confirmed", corrected: "Corrected", pending: "Needs review", rejected: "Rejected" };
const STATUS_TONE = { accepted: "ok", corrected: "ok", pending: "neutral", rejected: "bad" };
const group = (r) =>
  r.record_review === "accepted" || r.record_review === "corrected" ? "verified" : r.record_review === "rejected" ? "rejected" : "pending";
const PIN = { verified: "#0d5c4b", pending: "#a4571f", rejected: "#6b7780" };

// PostGIS points can arrive as GeoJSON, WKT or hex EWKB depending on the API; handle all three.
function parseLoc(v) {
  const ok = (lon, lat) => (Number.isFinite(lon) && Number.isFinite(lat) ? { lon, lat } : null);
  if (!v) return null;
  if (typeof v === "object" && Array.isArray(v.coordinates)) return ok(+v.coordinates[0], +v.coordinates[1]);
  if (typeof v !== "string") return null;
  const t = v.trim();
  const m = t.match(/POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)/i);
  if (m) return ok(+m[1], +m[2]);
  if (/^[0-9a-f]+$/i.test(t) && t.length >= 42) {
    try {
      const bytes = new Uint8Array(t.match(/../g).map((h) => parseInt(h, 16)));
      const dv = new DataView(bytes.buffer);
      const le = bytes[0] === 1;
      const type = dv.getUint32(1, le);
      const off = 5 + (type & 0x20000000 ? 4 : 0);
      return ok(dv.getFloat64(off, le), dv.getFloat64(off + 8, le));
    } catch { return null; }
  }
  return null;
}

const citeOf = (r, docById) => {
  const d = docById.get(r.document_id);
  if (!d) return "";
  return [d.original_author, d.original_year, d.title, r.source_page ? "p. " + r.source_page : null, d.original_ref].filter(Boolean).join(", ");
};

const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const download = (name, text, type) => {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
};

function MapView({ points }) {
  const el = useRef(null);
  useEffect(() => {
    const map = L.map(el.current, { scrollWheelZoom: false }).setView([-13.5, 27.8], 6);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);
    const layer = L.featureGroup().addTo(map);
    points.forEach((p) => {
      const marker = L.circleMarker([p.pos.lat, p.pos.lon], {
        radius: 8, color: "#ffffff", weight: 2, fillColor: PIN[group(p)], fillOpacity: 0.95,
      });
      const box = document.createElement("div");
      const title = document.createElement("b");
      title.textContent = p.name || "Unnamed occurrence";
      box.appendChild(title);
      [
        (p.commodities || []).join(", "),
        p.deposit_type,
        STATUS_LABEL[p.record_review],
        p.cite,
      ].filter(Boolean).forEach((line) => {
        const d = document.createElement("div");
        d.textContent = line;
        box.appendChild(d);
      });
      marker.bindPopup(box);
      layer.addLayer(marker);
    });
    if (points.length) map.fitBounds(layer.getBounds().pad(0.2), { maxZoom: 11 });
    return () => map.remove();
  }, [points]);
  return <div ref={el} className="map" />;
}

function Records({ ds, docs, active, note, onGoDocuments }) {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState("");
  const [commodity, setCommodity] = useState("");
  const [status, setStatus] = useState("all");
  const [view, setView] = useState("table");

  // Reload every time the tab is opened so reviewed values show up straight away
  useEffect(() => {
    if (!active) return;
    let live = true;
    (async () => {
      const { data, error } = await sb.from("mineral_occurrences")
        .select("id,name,commodities,deposit_type,occurrence_status,location,record_review,document_id,source_page,created_at")
        .eq("dataset_id", ds.id).order("created_at", { ascending: false }).limit(500);
      if (!live) return;
      if (error) { note(error.message, true); setRows([]); return; }
      setRows(data.map((r) => ({ ...r, pos: parseLoc(r.location) })));
    })();
    return () => { live = false; };
  }, [ds.id, active, docs]);

  const docById = useMemo(() => new Map(docs.map((d) => [d.id, d])), [docs]);
  const commodities = useMemo(
    () => [...new Set((rows || []).flatMap((r) => r.commodities || []))].sort((a, b) => a.localeCompare(b)),
    [rows]
  );
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (rows || [])
      .filter((r) => status === "all" || group(r) === status)
      .filter((r) => !commodity || (r.commodities || []).includes(commodity))
      .filter((r) => !needle || [r.name, r.deposit_type, r.occurrence_status, ...(r.commodities || [])].join(" ").toLowerCase().includes(needle))
      .map((r) => ({ ...r, cite: citeOf(r, docById) }));
  }, [rows, q, commodity, status, docById]);
  const points = useMemo(() => filtered.filter((r) => r.pos), [filtered]);

  const slug = (ds.name || "geomine").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "geomine";
  const exportCsv = () => {
    const head = ["name", "commodities", "deposit_type", "occurrence_status", "latitude", "longitude", "review_status", "source"];
    const lines = filtered.map((r) =>
      [r.name, (r.commodities || []).join("; "), r.deposit_type, r.occurrence_status, r.pos?.lat, r.pos?.lon, r.record_review, r.cite].map(csvCell).join(",")
    );
    download(slug + "-occurrences.csv", [head.join(","), ...lines].join("\n"), "text/csv");
  };
  const exportGeoJson = () => {
    const fc = {
      type: "FeatureCollection",
      features: points.map((r) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [r.pos.lon, r.pos.lat] },
        properties: {
          name: r.name, commodities: r.commodities, deposit_type: r.deposit_type,
          occurrence_status: r.occurrence_status, review_status: r.record_review, source: r.cite,
        },
      })),
    };
    download(slug + "-occurrences.geojson", JSON.stringify(fc, null, 2), "application/geo+json");
  };

  if (rows === null) {
    return (
      <div className="panel flush" aria-busy="true">
        <div className="toolbar" aria-hidden="true">
          <Sk w="38%" h={38} r={7} />
          <Sk w={150} h={38} r={7} />
          <Sk w={130} h={38} r={7} />
        </div>
        <SkTable heads={["Name", "Commodities", "Deposit type", "Status", "Coordinates", "Source"]} />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="empty">
        <h3>No records yet</h3>
        <p className="mut">Mineral occurrences appear here after you extract a document. Confirmed ones are ready to search, map and export.</p>
        <button className="btn" onClick={onGoDocuments}>Go to documents</button>
      </div>
    );
  }

  const unmapped = filtered.length - points.length;

  return (
    <div className="panel flush">
      <div className="toolbar">
        <input
          type="search"
          className="tb-search"
          placeholder="Search name, commodity or deposit type"
          aria-label="Search records"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select aria-label="Filter by commodity" value={commodity} onChange={(e) => setCommodity(e.target.value)}>
          <option value="">All commodities</option>
          {commodities.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select aria-label="Filter by review status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="all">All statuses</option>
          <option value="verified">Verified</option>
          <option value="pending">Needs review</option>
          <option value="rejected">Rejected</option>
        </select>
        <div className="seg compact" role="tablist" aria-label="Records view">
          <button role="tab" aria-selected={view === "table"} className={view === "table" ? "on" : ""} onClick={() => setView("table")}>Table</button>
          <button role="tab" aria-selected={view === "map"} className={view === "map" ? "on" : ""} onClick={() => setView("map")}>Map</button>
        </div>
      </div>

      <div className="toolbar sub">
        <span className="mut">Showing {filtered.length} of {rows.length} records</span>
        <span className="row">
          <button className="btn ghost sm" disabled={!filtered.length} onClick={exportCsv}>Export CSV</button>
          <button className="btn ghost sm" disabled={!points.length} onClick={exportGeoJson}>Export GeoJSON</button>
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="empty">
          <h3>No records match</h3>
          <p className="mut">Clear the search or change the filters to see more records.</p>
        </div>
      ) : view === "table" ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Name</th><th>Commodities</th><th>Deposit type</th><th>Status</th><th>Coordinates</th><th>Source</th></tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id}>
                  <td><b>{r.name || "Unnamed"}</b></td>
                  <td>
                    <span className="chips">
                      {(r.commodities || []).length ? r.commodities.map((c) => <span key={c} className="chip">{c}</span>) : <span className="mut">None</span>}
                    </span>
                  </td>
                  <td>{r.deposit_type || <span className="mut">Not stated</span>}</td>
                  <td><Badge tone={STATUS_TONE[r.record_review] || "neutral"}>{STATUS_LABEL[r.record_review] || r.record_review}</Badge></td>
                  <td className="nowrap">{r.pos ? r.pos.lat.toFixed(4) + ", " + r.pos.lon.toFixed(4) : <span className="mut">No location</span>}</td>
                  <td className="cite" title={r.cite}>{r.cite || <span className="mut">No source</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mapwrap">
          <MapView points={points} />
          <div className="legend">
            <span><i style={{ background: PIN.verified }} /> Verified</span>
            <span><i style={{ background: PIN.pending }} /> Needs review</span>
            <span><i style={{ background: PIN.rejected }} /> Rejected</span>
            {unmapped > 0 && <span className="mut">{unmapped} without coordinates are not shown</span>}
          </div>
        </div>
      )}
    </div>
  );
}
