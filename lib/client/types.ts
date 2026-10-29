export type Me = {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  avatarHue: number;
  publicKey: string;
  createdAt: string;
};

export type PublicUser = {
  id: string;
  username: string;
  displayName: string;
  bio?: string;
  avatarHue: number;
  publicKey: string;
  lastSeenAt?: string;
};

export type Member = PublicUser & { role: "owner" | "admin" | "member"; lastReadSeq: number; leftAt: string | null; joinedAt: string };

export type BlobRef = {
  id: string;
  key: string;
  iv: string;
  name: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
  duration?: number;
  thumb?: string;
};

export type Reply = { id: string; senderId: string; preview: string };

/** Everything inside a message's ciphertext. The server never sees any of this. */
export type Payload =
  | { t: "text"; body: string; reply?: Reply }
  | { t: "media"; kind: "image" | "file" | "voice"; blob: BlobRef; caption?: string; reply?: Reply }
  | { t: "poll"; question: string; options: string[]; multi: boolean }
  | { t: "vote"; poll: string; choices: number[] }
  | { t: "reaction"; target: string; emoji: string | null }
  | { t: "pin"; target: string; on: boolean }
  | { t: "payment"; note?: string }
  | { t: "request"; note?: string };

export type TransferRef = { kind: "transfer"; amount: number; fromId: string; toId: string };
export type SplitRef = {
  kind: "split";
  requesterId: string;
  items: { id: string; payerId: string; amount: number; status: "pending" | "paid" | "declined" | "cancelled" }[];
};

export type WireMessage = {
  id: string;
  conversationId: string;
  senderId: string;
  kind: "e2e" | "system" | "payment" | "request";
  epoch: number;
  iv: string | null;
  ciphertext: string | null;
  systemText: string | null;
  ref: TransferRef | SplitRef | null;
  revealAt: string | null;
  expiresAt: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  seq: number;
  createdAt: string;
};

export type WireConversation = {
  id: string;
  kind: "direct" | "group";
  createdBy: string;
  keyEpoch: number;
  needsRotation: boolean;
  encryptedMeta: string | null;
  disappearingSeconds: number | null;
  role: Member["role"];
  leftAt: string | null;
  createdAt: string;
  changeSeq: number;
  members: Member[];
  keys: { epoch: number; wrappedKey: string }[];
};

export type Message = Omit<WireMessage, "iv" | "ciphertext"> & {
  payload: Payload | null;
  /** Local state: still sending, failed to send, or undecryptable. */
  status?: "sending" | "failed" | "undecryptable";
  sealed?: boolean;
  wire?: WireMessage;
};

export type GroupMeta = { name: string; about?: string; emoji?: string };

export type Conversation = {
  id: string;
  kind: "direct" | "group";
  createdBy: string;
  keyEpoch: number;
  needsRotation: boolean;
  disappearingSeconds: number | null;
  role: Member["role"];
  leftAt: string | null;
  createdAt: string;
  members: Member[];
  meta: GroupMeta | null;
  encryptedMeta: string | null;
  keys: Map<number, CryptoKey>;
  wrapped: Map<number, string>;
  messages: Map<string, Message>;
  /** Set when a member's identity key differs from the one this device saw before. */
  keyWarning: string | null;
};
