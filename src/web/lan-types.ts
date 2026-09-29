// What the LAN routes report, in the shapes the section and its dialogs read.
//
// Lifted out of LanSyncSection.tsx unchanged. `/api/lan` answers with one
// LanStatus and every surface of this feature is drawn from it — the section,
// the deck's own dialog, the add and setup dialogs, and the request over the
// canvas — so its shape is a contract between the engine and all of them rather
// than something one component owns. The wording each field is turned into
// stays with whoever draws it.

/** What a paired deck says about itself, sealed to paired decks only — see
 *  lan-about.mjs. Any field can be missing, and all of them are from a deck
 *  older than the one that started sending them. */
export interface DeckAbout { version: string | null; os: string | null; arch: string | null; at?: number }

/** One account a paired deck offers, as its last manifest listed it. `alive`
 *  is that deck's verdict on its own copy, not this one's. */
export interface OfferedAccount { key: string; email: string; alive: boolean; shareable?: boolean }

/** One deck this one dials, as the status route reports it. */
export interface Peer {
  fp: string;
  /** The identity this row is really about: a heard deck's own fingerprint, or
   *  the one that answered at a typed address. Null while an address has never
   *  answered, which is the only state where there is nothing to name. */
  peerFp?: string | null;
  name: string;
  addr: string;
  port: number;
  manual?: boolean;
  /** A typed address that has answered at least once, so its name is the name
   *  the deck on the other end gave rather than the address we dialled. */
  met?: boolean;
  /** Somebody here pressed accept on this deck. */
  paired?: boolean;
  /** Paired, and this deck has no address to reach it at — it called us and we
   *  said yes, so it calls and we answer. */
  waiting?: boolean;
  lastSeen?: number;
  /** `why` on a row that did not arrive says why; on one that did, it is a
   *  problem this deck found with it after — see roundWhy. */
  last?: { at: number; error?: string; done?: Array<{ email: string; action: string; ok: boolean; why?: string | null }> } | null;
  /** What it said about itself. Null until it has, and forever for a deck
   *  older than the one that started saying. */
  about?: DeckAbout | null;
  /** The accounts it offered in its last manifest, and when — from the answer
   *  to this deck's question, or from the question a deck that calls in asks.
   *  Null for a deck that has not said, which is every deck older than the one
   *  that started saying. `current` is the one it is working on: the key of one
   *  of these, `hidden` when its owner switched that off, and `other` when it
   *  is on an account it does not share — which is never named. */
  offers?: {
    at: number;
    accounts: OfferedAccount[];
    current?: { key: string } | { hidden: true } | { other: true } | null;
  } | null;
  /** When somebody here accepted it. Null for a pairing made before this was
   *  kept, and for a row that is not paired. */
  pairedAt?: number | null;
  /** The accept switch paired it rather than a person. Such a deck may take
   *  what this one shares and places no login here that is not ticked here;
   *  pairing with it by invite makes it a person's choice. Absent otherwise. */
  autoPaired?: boolean;
  /** How it is reached: the local network, or this person's tailnet. Absent
   *  from a deck older than Tailscale discovery, and absent means local. */
  via?: LanRoute;
}

/** The two ways a deck is reached. */
export type LanRoute = "lan" | "tailscale";

/** A deck that finished a handshake, or was merely heard, and that nobody here
 *  has accepted yet. */
export interface LanStranger {
  fp: string; name: string; addr: string; port?: number; at: number;
  /** Heard or asked over the tailnet rather than the local network, and
   *  whether from a machine on this person's own Tailscale account. */
  via?: LanRoute;
  own?: boolean;
}

/** Discovery over Tailscale, as the engine reports it. Null on a deck that has
 *  no reader for it; `found: false` on a machine without Tailscale, where the
 *  dialog shows nothing about it at all. */
export interface LanTailscale {
  found: boolean;
  /** Tailscale's own word for its state: Running, Stopped, NeedsLogin… */
  state: string | null;
  running: boolean;
  on: boolean;
  ask: boolean;
  accept: boolean;
  /** The Tailscale account this machine is signed in to — the one whose
   *  machines count as this person's own. */
  login: string | null;
  addr: string | null;
  /** This person's machines online on the tailnet right now. */
  devices: number;
  /** This machine sends its traffic through a Tailscale exit node. */
  exitNode?: boolean;
}

export interface LanStatus {
  enabled: boolean;
  running: boolean;
  /** When every paired deck was last asked, from the engine. Null until the
   *  first round. */
  checkedAt?: number | null;
  /** Why there is no listener, on a deck that is switched on. Null every other
   *  time — including while it is still coming up. */
  stalled?: string | null;
  /** Running, and unable to hear other decks announce because another program
   *  holds the discovery port — said by the engine, with who holds it when the
   *  machine will say. Null whenever this deck can hear. */
  deaf?: string | null;
  /** Every local broadcast held back, because this machine sends its local
   *  network through a tunnel — a VPN, or a Tailscale exit node without local
   *  network access. */
  lanTunneled?: boolean;
  name: string;
  /** Whether this deck asks the machines it finds, and whether a request that
   *  arrives is answered here or answered for you. */
  autoAsk?: boolean;
  autoAccept?: boolean;
  pairingMode?: "automatic" | "invite";
  /** Whether paired decks are told which shared account this one is on.
   *  Absent is on, which is what the engine does with a missing setting. */
  shareActive?: boolean;
  tailscale?: LanTailscale | null;
  fp: string | null;
  port: number | null;
  /** When a connection from another machine last arrived here. Null on a deck
   *  nobody has dialled, which is not the same as one nothing can reach — see
   *  inboundAt in lan-inbound.mjs. */
  inboundAt?: number | null;
  addrs: string[];
  shared: string[];
  peers: Peer[];
  trusted: Array<{ fp: string; name: string }>;
  invite: LanInvite | null;
  pending: LanStranger[];
  strangers: LanStranger[];
  /** Decks somebody here said no to. They are not asked again and they are not
   *  offered as somebody to pair with; they are listed, with the one control
   *  that takes the answer back. */
  declined?: LanStranger[];
  /** Filled in by the section from prefs, so the modal can list what this deck
   *  dials without asking for prefs a second time. */
  manualRows?: string[];
  /** Whether other decks can reach this one, when the machine could be asked.
   *  Null on every platform this cannot measure and on the first poll after a
   *  start, and both mean the same thing: say nothing. See lan-reach.mjs. */
  reach?: LanReach | null;
  /** This deck's own card, so a peer's version can be read against it. */
  about?: DeckAbout | null;
  /** What somebody here calls other decks, by fingerprint. Applied to every
   *  name this section and the request dialog draw — see deckRows. */
  aliases?: Record<string, string>;
}

/** What lan-reach.mjs concluded, and the command it would have somebody paste.
 *  `steps` is text and only text — nothing here runs, for the reason
 *  relay-guard.mjs wrote down. */
export interface LanReach {
  blocked: boolean;
  why: string;
  category: string;
  alias: string;
  text?: string;
  steps?: string[];
  /** Where the steps are pasted. `powershell` wants an elevated window and
   *  `sh` an ordinary terminal — the verdict says which, so nothing here has
   *  to ask what platform it is drawing for. */
  shell?: "powershell" | "sh";
  /** Which Linux firewall the steps are written for, when it was one. */
  tool?: string;
  /** What the verdict could not check, in its own words. Linux only, and the
   *  honest half of that verdict: `ufw` shows its rules to root alone, so a
   *  machine that already allows the two ports looks exactly like one that
   *  does not. Drawn beside the steps rather than swallowed. */
  unsure?: string;
}

/** The accounts this deck holds, in the shape the panel already has them. */
export interface LanAccount { key: string; email: string; alive: boolean; shareable?: boolean }

/** What this deck is offering, and until when. */
export interface LanInvite { token: string; expiresAt: number }
