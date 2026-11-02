import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { CheckIcon, CloseIcon, CopyIcon, PlusIcon, SpinnerIcon, UsersIcon } from "./icons";
import type { SidebarColors } from "./MonthlySidebar";
import type { PasteResult } from "./CrewModal";
import { displayName } from "./observationStats";

// Shared crews live in the company SharePoint folder, one file per crew.
// Anyone with the code can view a crew; only its admins change it.

export interface CrewMember { name: string; email?: string | null; role: "admin" | "member"; addedBy?: string | null; addedAt?: string | null }
export interface SharedCrew { id: string; name: string; createdBy?: string | null; createdAt?: string | null; updatedAt?: string | null; members: CrewMember[] }
/** A crew added to this app, with the last copy read from SharePoint. */
export interface SharedCrewEntry { id: string; crew: SharedCrew | null; missing?: boolean; fetchedAt?: string }
export interface CrewRead { id: string; crew: SharedCrew | null; missing: boolean; error: string | null }
export interface Actor { name: string; email: string | null }
export type CrewRole = "admin" | "member" | "viewer";
export type CrewChange =
  | { kind: "addMembers"; members: { name: string; email: string | null }[] }
  | { kind: "removeMember"; name: string }
  | { kind: "setRole"; name: string; role: "admin" | "member" }
  | { kind: "rename"; name: string }
  | { kind: "delete" };

type ModalColors = SidebarColors & { modal_bg: string; modal_overlay: string };

const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function memberFor(crew: SharedCrew, me: Actor): CrewMember | undefined {
  return crew.members.find(m => (m.email && me.email ? same(m.email, me.email) : same(m.name, me.name)));
}
export function roleIn(crew: SharedCrew | null, me: Actor): CrewRole {
  return (crew && memberFor(crew, me)?.role) || "viewer";
}
export function inviteText(crew: SharedCrew): string {
  return `Join my ROAM crew "${crew.name}": in ROAM Logger open the Leaderboard, choose "Join or create a crew" and enter code ${crew.id}`;
}

function Shell({ colors, title, onClose, children }: { colors: ModalColors; title: React.ReactNode; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }} style={{ position: "fixed", inset: 0, backgroundColor: colors.modal_overlay, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: "20px" }}>
      <div role="dialog" aria-label={typeof title === "string" ? title : "Crew"} style={{ backgroundColor: colors.modal_bg, color: colors.text, borderRadius: "8px", width: "100%", maxWidth: "460px", maxHeight: "86vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 4px 20px rgba(0,0,0,0.3)", border: `1px solid ${colors.border}` }}>
        <div style={{ padding: "6px 6px 6px 10px", minHeight: "36px", boxSizing: "border-box", backgroundColor: colors.surface, borderBottom: `1px solid ${colors.border}`, fontWeight: "bold", fontSize: "13px", display: "flex", alignItems: "center", gap: "6px" }}>
          <UsersIcon size={15} /> <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
          <button type="button" onClick={onClose} aria-label="Close" title="Close" className="icon-btn" style={{ width: "24px", height: "24px", padding: 0, border: "none", borderRadius: "4px", background: "none", color: colors.text_muted, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><CloseIcon /></button>
        </div>
        <div style={{ padding: "10px", display: "flex", flexDirection: "column", gap: "10px", overflowY: "auto", minHeight: 0 }}>{children}</div>
      </div>
    </div>
  );
}

const styles = (colors: ModalColors) => {
  const btn = { padding: "6px 10px", border: `1px solid ${colors.border}`, borderRadius: "4px", backgroundColor: colors.input_bg, fontWeight: "bold" as const, color: colors.text, fontSize: "11px", cursor: "pointer", fontFamily: "inherit", display: "inline-flex", alignItems: "center", gap: "4px" };
  return {
    btn,
    primaryBtn: { ...btn, backgroundColor: colors.primary, borderColor: colors.primary, color: "#FFFFFF" },
    smallBtn: { ...btn, padding: "2px 7px" },
    input: { width: "100%", boxSizing: "border-box" as const, padding: "6px 8px", border: `1px solid ${colors.border}`, borderRadius: "4px", backgroundColor: colors.input_bg, color: colors.text, fontFamily: "inherit", fontSize: "13px", userSelect: "text" as const },
    sectionTitle: { fontSize: "11px", fontWeight: "bold" as const, letterSpacing: "0.3px", color: colors.text },
    muted: { fontSize: "13px", color: colors.text_muted, lineHeight: 1.4 },
    error: { fontSize: "13px", color: "#CF222E" },
  };
};

function RoleBadge({ role, colors }: { role: CrewRole; colors: ModalColors }) {
  const admin = role === "admin";
  return (
    <span style={{ padding: "0 5px", borderRadius: "3px", fontSize: "10px", lineHeight: "16px", fontWeight: "bold", textTransform: "uppercase", letterSpacing: "0.3px", border: `1px solid ${admin ? colors.primary : colors.border}`, color: admin ? colors.primary : colors.text_muted }}>
      {role}
    </span>
  );
}

/** Join a crew by its code, or create a new one. */
export function AddCrewModal({ colors, me, personalCrew, personalEmails, onFind, onCreate, onAdd, onClose }: {
  colors: ModalColors;
  me: Actor | null;
  /** The user's own (not shared) crew list, offered as starting members */
  personalCrew: string[];
  personalEmails: Record<string, string>;
  onFind: (code: string) => Promise<CrewRead | null>;
  onCreate: (name: string, members: { name: string; email: string | null }[]) => Promise<SharedCrew>;
  onAdd: (crew: SharedCrew, created: boolean) => void;
  onClose: () => void;
}) {
  const s = styles(colors);
  const [code, setCode] = useState("");
  const [found, setFound] = useState<SharedCrew | null>(null);
  const [name, setName] = useState("");
  const [withCrew, setWithCrew] = useState(personalCrew.length > 0);
  const [busy, setBusy] = useState<"" | "find" | "create">("");
  const [error, setError] = useState("");

  const find = async () => {
    setBusy("find"); setError(""); setFound(null);
    try {
      const r = await onFind(code);
      if (!r) setError("That doesn't look like a crew code. Codes have 6 letters and numbers, e.g. 7KQ4M2.");
      else if (r.crew) setFound(r.crew);
      else setError(r.missing ? "No crew has that code. Check it with the person who shared it." : r.error || "Could not read the crew.");
    } catch (e) { setError(`${e}`); } finally { setBusy(""); }
  };
  const create = async () => {
    setBusy("create"); setError("");
    try {
      onAdd(await onCreate(name, withCrew ? personalCrew.map(n => ({ name: n, email: personalEmails[n] ?? null })) : []), true);
    } catch (e) { setError(`${e}`); } finally { setBusy(""); }
  };

  return (
    <Shell colors={colors} title="Join or create a crew" onClose={onClose}>
      <div style={s.muted}>Shared crews are kept for everyone in the company. Anyone with the code can follow a crew; its admins decide who is a member.</div>

      <div style={s.sectionTitle}>JOIN WITH A CODE</div>
      <div style={{ display: "flex", gap: "6px" }}>
        <input value={code} onChange={e => { setCode(e.target.value); setFound(null); setError(""); }} onKeyDown={e => { if (e.key === "Enter" && code.trim()) find(); }} placeholder="Crew code, e.g. 7KQ4M2" aria-label="Crew code" style={{ ...s.input, textTransform: "uppercase", letterSpacing: "1px" }} />
        <button type="button" onClick={find} disabled={!code.trim() || !!busy} style={{ ...s.btn, flexShrink: 0, opacity: code.trim() ? 1 : 0.6, cursor: busy ? "wait" : "pointer" }}>
          {busy === "find" ? <SpinnerIcon size={12} /> : null} Find crew
        </button>
      </div>
      {found && me && (
        <div style={{ border: `1px solid ${colors.border}`, borderRadius: "4px", padding: "8px", display: "flex", flexDirection: "column", gap: "6px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <b style={{ flex: 1, fontSize: "13px" }}>{found.name}</b>
            <span style={{ fontSize: "11px", color: colors.text_muted }}>{found.members.length} member{found.members.length === 1 ? "" : "s"}</span>
          </div>
          <div style={{ fontSize: "11px", color: colors.text_muted }}>
            Admin: {found.members.filter(m => m.role === "admin").map(m => displayName(m.name)).join(", ")}
          </div>
          <div style={{ fontSize: "13px" }}>
            {roleIn(found, me) === "viewer" ? "You'll follow this crew. To be on its leaderboard, ask an admin to add you." : `You're ${roleIn(found, me) === "admin" ? "an admin" : "a member"} of this crew.`}
          </div>
          <button type="button" onClick={() => onAdd(found, false)} style={{ ...s.primaryBtn, alignSelf: "flex-end" }}>Add to my leaderboard</button>
        </div>
      )}

      <div style={{ ...s.sectionTitle, marginTop: "4px" }}>CREATE A CREW</div>
      {me ? <>
        <input value={name} onChange={e => { setName(e.target.value); setError(""); }} onKeyDown={e => { if (e.key === "Enter" && name.trim()) create(); }} placeholder="Crew name, e.g. Cape Town Mech" aria-label="Crew name" maxLength={60} style={s.input} />
        {personalCrew.length > 0 && (
          <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", cursor: "pointer" }}>
            <input type="checkbox" checked={withCrew} onChange={e => setWithCrew(e.target.checked)} />
            Start with the {personalCrew.length} people in My crew
          </label>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ flex: 1, fontSize: "11px", color: colors.text_muted }}>You'll be its admin.</span>
          <button type="button" onClick={create} disabled={!name.trim() || !!busy} style={{ ...s.primaryBtn, opacity: name.trim() ? 1 : 0.6, cursor: busy ? "wait" : name.trim() ? "pointer" : "not-allowed" }}>
            {busy === "create" ? <SpinnerIcon size={12} /> : null} Create crew
          </button>
        </div>
      </> : <div style={s.muted}>Your name has to load first. Wait for your own counts to appear, then try again.</div>}

      {busy && <div style={{ ...s.muted, display: "flex", alignItems: "center", gap: "6px" }}><SpinnerIcon size={13} /> {busy === "find" ? "Looking up the crew..." : "Creating the crew..."} This takes about 15 seconds.</div>}
      {error && <div role="alert" style={s.error}>{error}</div>}
    </Shell>
  );
}

/** One shared crew: invite code, members and (for admins) managing them. */
export function SharedCrewModal({ colors, entry, me, personalCrew, onChange, onFindPeople, onCopyInvite, onAskToJoin, onRemoveFromApp, onClose }: {
  colors: ModalColors;
  entry: SharedCrewEntry;
  me: Actor | null;
  personalCrew: string[];
  /** Saves a change; resolves when SharePoint has it */
  onChange: (change: CrewChange) => Promise<void>;
  onFindPeople: (lines: string[]) => Promise<PasteResult>;
  onCopyInvite: () => void;
  onAskToJoin: () => void;
  onRemoveFromApp: () => void;
  onClose: () => void;
}) {
  const s = styles(colors);
  const crew = entry.crew;
  const role: CrewRole = crew && me ? roleIn(crew, me) : "viewer";
  const isAdmin = role === "admin";
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [found, setFound] = useState<PasteResult | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);

  const change = async (label: string, c: CrewChange) => {
    setBusy(label); setError("");
    try { await onChange(c); return true; } catch (e) { setError(`${e}`); return false; } finally { setBusy(""); }
  };
  const inCrew = (name: string) => !!crew?.members.some(m => same(m.name, name));
  const find = async () => {
    setBusy("find"); setError(""); setFound(null);
    try {
      const r = await onFindPeople(text.split(/\r?\n/));
      setFound(r);
      setChosen(new Set(r.matches.map(m => m.name).filter(n => !inCrew(n))));
    } catch (e) { setError(`${e}`); } finally { setBusy(""); }
  };
  const addChosen = async () => {
    const members = [...chosen].map(name => ({ name, email: found?.emails?.[name] ?? null }));
    if (await change("add", { kind: "addMembers", members })) { setText(""); setFound(null); setChosen(new Set()); }
  };

  if (!crew) {
    return (
      <Shell colors={colors} title={`Crew ${entry.id}`} onClose={onClose}>
        <div style={s.muted}>{entry.missing ? "This crew was deleted by its admin." : "This crew hasn't loaded yet. Refresh the leaderboard to try again."}</div>
        <button type="button" onClick={onRemoveFromApp} style={{ ...s.btn, alignSelf: "flex-start" }}>Remove from my leaderboard</button>
      </Shell>
    );
  }
  const admins = crew.members.filter(m => m.role === "admin").length;
  const sorted = [...crew.members].sort((a, b) => (a.role === b.role ? displayName(a.name).localeCompare(displayName(b.name)) : a.role === "admin" ? -1 : 1));
  const quickAdd = personalCrew.filter(n => !inCrew(n));

  return (
    <Shell colors={colors} title={crew.name} onClose={onClose}>
      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
        {renaming !== null ? <>
          <input value={renaming} onChange={e => setRenaming(e.target.value)} maxLength={60} aria-label="New crew name" style={s.input} autoFocus
            onKeyDown={async e => { if (e.key === "Enter" && renaming.trim() && await change("rename", { kind: "rename", name: renaming })) setRenaming(null); if (e.key === "Escape") { e.stopPropagation(); setRenaming(null); } }} />
          <button type="button" disabled={!renaming.trim() || !!busy} onClick={async () => { if (await change("rename", { kind: "rename", name: renaming })) setRenaming(null); }} style={s.smallBtn}>Save</button>
        </> : <>
          <span style={{ flex: 1, fontSize: "13px" }}>You're {role === "viewer" ? "following this crew" : role === "admin" ? "an admin" : "a member"}</span>
          <RoleBadge role={role} colors={colors} />
          {isAdmin && <button type="button" onClick={() => setRenaming(crew.name)} style={s.smallBtn}>Rename</button>}
        </>}
      </div>

      <div style={{ display: "flex", gap: "10px", alignItems: "center", border: `1px solid ${colors.border}`, borderRadius: "4px", padding: "8px" }}>
        <div style={{ background: "#FFFFFF", padding: "4px", borderRadius: "4px", display: "flex" }}>
          <QRCodeSVG value={inviteText(crew)} size={84} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 }}>
          <div style={{ fontSize: "11px", color: colors.text_muted }}>Crew code</div>
          <div style={{ fontSize: "22px", fontWeight: "bold", letterSpacing: "3px", userSelect: "text" }} aria-label="Crew code">{crew.id}</div>
          <button type="button" onClick={onCopyInvite} style={{ ...s.smallBtn, alignSelf: "flex-start" }}><CopyIcon size={12} /> Copy invite</button>
        </div>
      </div>

      {role === "viewer" && (
        <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "8px", borderRadius: "4px", backgroundColor: colors.surface }}>
          <span style={{ flex: 1, fontSize: "13px" }}>Only admins can add members. Ask one to add you.</span>
          <button type="button" onClick={onAskToJoin} style={s.primaryBtn}>Ask to join</button>
        </div>
      )}

      <div style={s.sectionTitle}>MEMBERS ({crew.members.length})</div>
      <div style={{ border: `1px solid ${colors.border}`, borderRadius: "4px", maxHeight: "200px", overflowY: "auto" }}>
        {sorted.map(m => {
          const isMe = !!me && (m.email && me.email ? same(m.email, me.email) : same(m.name, me.name));
          const lastAdmin = m.role === "admin" && admins === 1;
          return (
            <div key={m.name} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "4px 8px", borderBottom: `1px solid ${colors.border}`, fontSize: "13px" }}>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: isMe ? "bold" : "normal" }}>{displayName(m.name)}{isMe ? " (you)" : ""}</span>
              <RoleBadge role={m.role} colors={colors} />
              {isAdmin && (
                <button type="button" disabled={!!busy || lastAdmin} title={lastAdmin ? "A crew needs at least one admin" : undefined}
                  onClick={() => change("role", { kind: "setRole", name: m.name, role: m.role === "admin" ? "member" : "admin" })}
                  style={{ ...s.smallBtn, opacity: lastAdmin ? 0.5 : 1, cursor: lastAdmin ? "not-allowed" : "pointer" }}>
                  {m.role === "admin" ? "Make member" : "Make admin"}
                </button>
              )}
              {isAdmin && (
                <button type="button" disabled={!!busy || lastAdmin} onClick={() => change("remove", { kind: "removeMember", name: m.name })}
                  aria-label={`Remove ${displayName(m.name)} from the crew`} title={lastAdmin ? "A crew needs at least one admin" : "Remove from the crew"} className="icon-btn"
                  style={{ width: "20px", height: "20px", padding: 0, border: "none", borderRadius: "3px", background: "none", color: colors.text_muted, cursor: lastAdmin ? "not-allowed" : "pointer", opacity: lastAdmin ? 0.4 : 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <CloseIcon size={11} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {isAdmin && <>
        <div style={s.sectionTitle}>ADD MEMBERS</div>
        {quickAdd.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
            {quickAdd.slice(0, 12).map(n => (
              <button key={n} type="button" disabled={!!busy} onClick={() => change("add", { kind: "addMembers", members: [{ name: n, email: null }] })} title={`Add ${displayName(n)} from My crew`} style={{ ...s.smallBtn, fontWeight: "normal", fontSize: "12px" }}>
                <PlusIcon size={10} /> {displayName(n)}
              </button>
            ))}
          </div>
        )}
        <textarea value={text} onChange={e => { setText(e.target.value); setFound(null); }} rows={3} aria-label="Names to add"
          placeholder={"Paste names or emails, one per line:\nWillem du Plooy\nthabo.dlamini@hatch.com"} style={{ ...s.input, resize: "vertical" }} />
        <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          <button type="button" onClick={find} disabled={!text.trim() || !!busy} style={{ ...s.btn, opacity: text.trim() ? 1 : 0.6 }}>Find people</button>
          {found && <span style={{ fontSize: "13px" }}>Found <b>{found.matches.length}</b>{found.unmatched.length ? `, not found: ${found.unmatched.join(", ")}` : ""}</span>}
        </div>
        {found && found.matches.length > 0 && <>
          <div style={{ border: `1px solid ${colors.border}`, borderRadius: "4px", maxHeight: "140px", overflowY: "auto" }}>
            {found.matches.filter((m, i, all) => all.findIndex(x => x.name === m.name) === i).map(m => {
              const already = inCrew(m.name);
              return (
                <label key={m.name} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "4px 8px", borderBottom: `1px solid ${colors.border}`, fontSize: "13px", color: already ? colors.text_muted : colors.text }}>
                  <input type="checkbox" checked={already || chosen.has(m.name)} disabled={already} onChange={() => setChosen(prev => { const n = new Set(prev); if (n.has(m.name)) n.delete(m.name); else n.add(m.name); return n; })} />
                  <span style={{ flex: 1 }}>{displayName(m.name)}</span>
                  {already && <span style={{ display: "flex", alignItems: "center", gap: "3px", fontSize: "11px" }}><CheckIcon size={12} /> member</span>}
                </label>
              );
            })}
          </div>
          <button type="button" onClick={addChosen} disabled={chosen.size === 0 || !!busy} style={{ ...s.primaryBtn, alignSelf: "flex-end", opacity: chosen.size ? 1 : 0.6 }}>Add {chosen.size} to the crew</button>
        </>}
      </>}

      {busy && <div style={{ ...s.muted, display: "flex", alignItems: "center", gap: "6px" }}><SpinnerIcon size={13} /> {busy === "find" ? "Finding people..." : "Saving to the shared folder..."}</div>}
      {error && <div role="alert" style={s.error}>{error}</div>}

      <div style={{ display: "flex", gap: "6px", justifyContent: "space-between", borderTop: `1px solid ${colors.border}`, paddingTop: "8px" }}>
        <button type="button" onClick={onRemoveFromApp} title={role === "viewer" ? undefined : "Hides it here only; ask an admin to take you off the crew"} style={s.btn}>Remove from my leaderboard</button>
        {isAdmin && (confirmDelete
          ? <button type="button" disabled={!!busy} onClick={() => change("delete", { kind: "delete" })} style={{ ...s.btn, borderColor: "#CF222E", color: "#FFFFFF", backgroundColor: "#CF222E" }}>Delete for everyone?</button>
          : <button type="button" onClick={() => setConfirmDelete(true)} style={{ ...s.btn, color: "#CF222E" }}>Delete crew</button>)}
      </div>
    </Shell>
  );
}
