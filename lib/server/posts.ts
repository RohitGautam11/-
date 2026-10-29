export const MOODS = ["thought", "gratitude", "idea", "question", "celebrate", "help"] as const;

export type PostRow = {
  id: string; body: string; image_blob_id: string | null; mood: string | null; like_count: number; comment_count: number;
  created_at: Date; author_id: string; username: string; display_name: string; avatar_hue: number; liked: boolean;
};

export const POST_SELECT = `
  SELECT p.id, p.body, p.image_blob_id, p.mood, p.like_count, p.comment_count, p.created_at,
         u.id AS author_id, u.username, u.display_name, u.avatar_hue,
         EXISTS (SELECT 1 FROM post_likes l WHERE l.post_id = p.id AND l.user_id = $1) AS liked
    FROM posts p JOIN users u ON u.id = p.author_id`;

export function postView(row: PostRow) {
  return {
    id: row.id,
    body: row.body,
    imageUrl: row.image_blob_id ? `/api/blobs/${row.image_blob_id}` : null,
    mood: row.mood,
    likeCount: row.like_count,
    commentCount: row.comment_count,
    liked: row.liked,
    createdAt: row.created_at,
    author: { id: row.author_id, username: row.username, displayName: row.display_name, avatarHue: row.avatar_hue },
  };
}
