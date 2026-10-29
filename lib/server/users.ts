import type { SessionUser } from "./auth";

/** Shape of the signed-in user returned to the client. */
export function selfView(user: SessionUser) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    bio: user.bio,
    avatarHue: user.avatar_hue,
    publicKey: user.public_key,
    createdAt: user.created_at,
  };
}

export type PublicUserRow = {
  id: string;
  username: string;
  display_name: string;
  bio: string;
  avatar_hue: number;
  public_key: string;
  last_seen_at: string | Date;
};

export const PUBLIC_USER_COLUMNS = "u.id, u.username, u.display_name, u.bio, u.avatar_hue, u.public_key, u.last_seen_at";

export function publicView(row: PublicUserRow) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    bio: row.bio,
    avatarHue: row.avatar_hue,
    publicKey: row.public_key,
    lastSeenAt: row.last_seen_at,
  };
}
