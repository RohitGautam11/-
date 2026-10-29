// Bump SCHEMA_VERSION whenever SCHEMA_SQL changes. Every statement must be idempotent.
export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL: string[] = [
  // One global, monotonically increasing change counter drives incremental sync.
  `CREATE SEQUENCE IF NOT EXISTS change_seq`,

  `CREATE TABLE IF NOT EXISTS users (
    id uuid PRIMARY KEY,
    username text NOT NULL UNIQUE,
    display_name text NOT NULL,
    bio text NOT NULL DEFAULT '',
    avatar_hue int NOT NULL DEFAULT 24,
    auth_hash text NOT NULL,
    kdf_salt text NOT NULL,
    kdf_iterations int NOT NULL,
    public_key text NOT NULL,
    encrypted_private_key text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_agent text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id)`,

  `CREATE TABLE IF NOT EXISTS conversations (
    id uuid PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('direct', 'group')),
    direct_key text UNIQUE,
    created_by uuid NOT NULL REFERENCES users(id),
    key_epoch int NOT NULL DEFAULT 1,
    needs_rotation boolean NOT NULL DEFAULT false,
    encrypted_meta text,
    disappearing_seconds int,
    change_seq bigint NOT NULL DEFAULT nextval('change_seq'),
    touched_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS conversations_change_idx ON conversations(change_seq)`,

  `CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
    joined_at timestamptz NOT NULL DEFAULT now(),
    left_at timestamptz,
    last_read_seq bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (conversation_id, user_id)
  )`,
  `CREATE INDEX IF NOT EXISTS members_user_idx ON conversation_members(user_id)`,

  // Conversation keys, wrapped (ECDH + HKDF + AES-GCM) separately for every member and key epoch.
  `CREATE TABLE IF NOT EXISTS conversation_keys (
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    epoch int NOT NULL,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    wrapped_key text NOT NULL,
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id, epoch, user_id)
  )`,

  // kind: 'e2e' (opaque ciphertext), 'system' (membership notices), 'payment' / 'request' (ref_id -> ledger).
  `CREATE TABLE IF NOT EXISTS messages (
    id uuid PRIMARY KEY,
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id uuid NOT NULL REFERENCES users(id),
    kind text NOT NULL DEFAULT 'e2e' CHECK (kind IN ('e2e', 'system', 'payment', 'request')),
    epoch int NOT NULL DEFAULT 0,
    iv text,
    ciphertext text,
    system_text text,
    ref_id uuid,
    reveal_at timestamptz,
    revealed boolean NOT NULL DEFAULT true,
    expires_at timestamptz,
    edited_at timestamptz,
    deleted_at timestamptz,
    seq bigint NOT NULL DEFAULT nextval('change_seq'),
    touched_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS messages_conv_seq_idx ON messages(conversation_id, seq)`,
  `CREATE INDEX IF NOT EXISTS messages_reveal_idx ON messages(reveal_at) WHERE NOT revealed`,
  `CREATE INDEX IF NOT EXISTS messages_expiry_idx ON messages(expires_at) WHERE expires_at IS NOT NULL`,

  // Encrypted attachments (chat) or public images (posts). Ciphertext only for chat blobs.
  `CREATE TABLE IF NOT EXISTS blobs (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
    is_public boolean NOT NULL DEFAULT false,
    content_type text NOT NULL DEFAULT 'application/octet-stream',
    size int NOT NULL,
    data bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,

  // Wallet: balances in paise, every movement mirrored in an append-only ledger.
  `CREATE TABLE IF NOT EXISTS wallets (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    balance_paise bigint NOT NULL DEFAULT 0 CHECK (balance_paise >= 0),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS transfers (
    id uuid PRIMARY KEY,
    from_user uuid REFERENCES users(id),
    to_user uuid NOT NULL REFERENCES users(id),
    amount_paise bigint NOT NULL CHECK (amount_paise > 0),
    kind text NOT NULL CHECK (kind IN ('transfer', 'topup', 'bonus')),
    conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
    request_id uuid,
    idempotency_key text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (from_user, idempotency_key)
  )`,
  `CREATE TABLE IF NOT EXISTS ledger_entries (
    id bigserial PRIMARY KEY,
    transfer_id uuid NOT NULL REFERENCES transfers(id),
    user_id uuid NOT NULL REFERENCES users(id),
    amount_paise bigint NOT NULL,
    balance_after bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS ledger_user_idx ON ledger_entries(user_id, id DESC)`,
  // A split is one chat card that asks one or more people to pay their share.
  `CREATE TABLE IF NOT EXISTS payment_requests (
    id uuid PRIMARY KEY,
    split_id uuid NOT NULL,
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    requester_id uuid NOT NULL REFERENCES users(id),
    payer_id uuid NOT NULL REFERENCES users(id),
    amount_paise bigint NOT NULL CHECK (amount_paise > 0),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'declined', 'cancelled')),
    transfer_id uuid REFERENCES transfers(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz
  )`,
  `CREATE INDEX IF NOT EXISTS requests_split_idx ON payment_requests(split_id)`,
  `CREATE INDEX IF NOT EXISTS requests_payer_idx ON payment_requests(payer_id, status)`,
  `CREATE INDEX IF NOT EXISTS messages_ref_idx ON messages(ref_id) WHERE ref_id IS NOT NULL`,

  // Social: public posts are intentionally NOT end-to-end encrypted.
  `CREATE TABLE IF NOT EXISTS posts (
    id uuid PRIMARY KEY,
    author_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body text NOT NULL,
    image_blob_id uuid REFERENCES blobs(id) ON DELETE SET NULL,
    mood text,
    like_count int NOT NULL DEFAULT 0,
    comment_count int NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS posts_created_idx ON posts(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS posts_author_idx ON posts(author_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS post_likes (
    post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (post_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS post_comments (
    id uuid PRIMARY KEY,
    post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    author_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS comments_post_idx ON post_comments(post_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS follows (
    follower_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    followee_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (follower_id, followee_id)
  )`,
  `CREATE INDEX IF NOT EXISTS follows_followee_idx ON follows(followee_id)`,

  `CREATE TABLE IF NOT EXISTS rate_limits (
    bucket text PRIMARY KEY,
    window_start timestamptz NOT NULL,
    hits int NOT NULL
  )`,
];
