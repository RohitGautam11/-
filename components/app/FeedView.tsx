"use client";

import { Globe2, Heart, ImagePlus, MessageCircle, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { prepareImage } from "@/lib/client/media";
import { ago } from "@/lib/client/selectors";
import { useAction, useEngine, useToast } from "./context";
import { Avatar, Empty, RichText, Spinner } from "./ui";

export type Post = {
  id: string; body: string; imageUrl: string | null; mood: string | null; likeCount: number; commentCount: number;
  liked: boolean; createdAt: string; author: { id: string; username: string; displayName: string; avatarHue: number };
};
type Comment = { id: string; body: string; createdAt: string; author: Post["author"] };

export const MOODS: Record<string, { emoji: string; label: string }> = {
  thought: { emoji: "💭", label: "Thought" },
  gratitude: { emoji: "🙏", label: "Gratitude" },
  idea: { emoji: "💡", label: "Idea" },
  question: { emoji: "❓", label: "Question" },
  celebrate: { emoji: "🎉", label: "Celebrate" },
  help: { emoji: "🤝", label: "Need help" },
};

export function FeedView({ onOpenProfile }: { onOpenProfile: (username: string) => void }) {
  const [scope, setScope] = useState<"feed" | "explore">("feed");
  // Results are tagged with the scope they belong to, so switching tabs shows a spinner, not stale posts.
  const [data, setData] = useState<{ scope: string; posts: Post[]; more: boolean } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const posts = data?.scope === scope ? data.posts : null;
  const more = data?.scope === scope && data.more;
  const setPosts = (fn: (p: Post[] | null) => Post[]) => setData((d) => (d ? { ...d, posts: fn(d.posts) } : d));

  const fetchPage = useCallback(
    (before?: string) => api<{ posts: Post[]; more: boolean }>(`/api/posts?scope=${scope}${before ? `&before=${encodeURIComponent(before)}` : ""}`),
    [scope],
  );
  const load = async (before: string) => {
    const res = await fetchPage(before);
    setData((d) => ({ scope, more: res.more, posts: d?.scope === scope ? [...d.posts, ...res.posts] : res.posts }));
  };

  useEffect(() => {
    let live = true;
    fetchPage()
      .then((res) => live && setData({ scope, posts: res.posts, more: res.more }))
      .catch(() => live && setData({ scope, posts: [], more: false }));
    return () => {
      live = false;
    };
  }, [fetchPage, scope]);

  return (
    <div className="feed">
      <header className="page-head">
        <div>
          <h1>Vichaar <span className="muted">· विचार</span></h1>
          <p className="muted">Share thoughts with the people who follow you. Posts are public — chats stay private.</p>
        </div>
      </header>
      <PostComposer onPosted={(p) => setPosts((x) => [p, ...(x ?? [])])} />
      <div className="segmented">
        <button className={scope === "feed" ? "active" : ""} onClick={() => setScope("feed")}>Following</button>
        <button className={scope === "explore" ? "active" : ""} onClick={() => setScope("explore")}><Globe2 size={14} /> Explore</button>
      </div>
      {posts === null && <div className="center pad"><Spinner /></div>}
      {posts?.length === 0 && (
        <Empty icon="🪔" title={scope === "feed" ? "Your feed is quiet" : "No posts yet"}>
          {scope === "feed" ? <p>Follow people from Explore, or be the first to share something.</p> : <p>Be the first to share a vichaar.</p>}
        </Empty>
      )}
      <div className="posts">
        {posts?.map((p) => (
          <PostCard key={p.id} post={p} onOpenProfile={onOpenProfile}
            onChange={(next) => setPosts((x) => x!.map((y) => (y.id === p.id ? next : y)))}
            onDelete={() => setPosts((x) => x!.filter((y) => y.id !== p.id))} />
        ))}
      </div>
      {more && posts && (
        <button className="btn btn-ghost btn-block" disabled={loadingMore} onClick={() => {
          setLoadingMore(true);
          void load(posts[posts.length - 1].createdAt).finally(() => setLoadingMore(false));
        }}>{loadingMore ? <Spinner /> : "Load more"}</button>
      )}
    </div>
  );
}

function PostComposer({ onPosted }: { onPosted: (p: Post) => void }) {
  const engine = useEngine();
  const [run, busy] = useAction();
  const [body, setBody] = useState("");
  const [mood, setMood] = useState<string>("thought");
  const [image, setImage] = useState<{ blob: Blob; preview: string } | null>(null);

  useEffect(() => () => {
    if (image) URL.revokeObjectURL(image.preview);
  }, [image]);

  return (
    <div className="post-composer">
      <Avatar name={engine.me.displayName} hue={engine.me.avatarHue} size={42} />
      <div className="grow">
        <textarea className="input" rows={2} value={body} onChange={(e) => setBody(e.target.value)} placeholder={`What's on your mind, ${engine.me.displayName.split(" ")[0]}?`} maxLength={2000} />
        {image && (
          <div className="post-image-preview">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={image.preview} alt="" />
            <button className="icon-btn" onClick={() => setImage(null)} aria-label="Remove photo"><X size={16} /></button>
          </div>
        )}
        <div className="post-composer-bar">
          <div className="moods">
            {Object.entries(MOODS).map(([key, m]) => (
              <button key={key} className={mood === key ? "on" : ""} onClick={() => setMood(key)} title={m.label} aria-label={m.label}>{m.emoji}</button>
            ))}
          </div>
          <label className="icon-btn" title="Add photo" aria-label="Add photo">
            <ImagePlus size={19} />
            <input type="file" accept="image/*" hidden onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const img = await prepareImage(file, 1800);
              setImage({ blob: img.blob, preview: URL.createObjectURL(img.blob) });
            }} />
          </label>
          <button className="btn btn-primary sm" disabled={busy || (!body.trim() && !image)} onClick={() => void run(async () => {
            let imageBlobId: string | undefined;
            if (image) {
              imageBlobId = (await api<{ id: string }>("/api/blobs?public=1", { raw: image.blob, headers: { "content-type": "image/jpeg" } })).id;
            }
            const res = await api<{ post: Post }>("/api/posts", { body: { body: body.trim(), mood, imageBlobId } });
            onPosted(res.post);
            setBody("");
            setImage(null);
          })}>{busy ? <Spinner /> : "Post"}</button>
        </div>
      </div>
    </div>
  );
}

export function PostCard({ post, onChange, onDelete, onOpenProfile }: {
  post: Post; onChange: (p: Post) => void; onDelete: () => void; onOpenProfile: (username: string) => void;
}) {
  const engine = useEngine();
  const toast = useToast();
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [open, setOpen] = useState(false);
  const [reply, setReply] = useState("");
  const [run, busy] = useAction();
  const mood = post.mood ? MOODS[post.mood] : null;

  const like = async () => {
    const optimistic = { ...post, liked: !post.liked, likeCount: post.likeCount + (post.liked ? -1 : 1) };
    onChange(optimistic);
    try {
      const res = await api<{ liked: boolean; likeCount: number }>(`/api/posts/${post.id}/like`, { body: {} });
      onChange({ ...optimistic, ...res });
    } catch (e) {
      onChange(post);
      toast((e as Error).message, "error");
    }
  };

  const toggleComments = async () => {
    setOpen(!open);
    if (!comments) setComments((await api<{ comments: Comment[] }>(`/api/posts/${post.id}/comments`)).comments);
  };

  return (
    <article className="post">
      <header className="post-head">
        <button className="post-author" onClick={() => onOpenProfile(post.author.username)}>
          <Avatar name={post.author.displayName} hue={post.author.avatarHue} size={42} />
          <span><strong>{post.author.displayName}</strong><small>@{post.author.username} · {ago(post.createdAt)}</small></span>
        </button>
        {mood && <span className="mood-tag">{mood.emoji} {mood.label}</span>}
        {post.author.id === engine.me.id && (
          <button className="icon-btn" aria-label="Delete post" onClick={() => confirm("Delete this post?") && void run(async () => {
            await api(`/api/posts/${post.id}`, { method: "DELETE" });
            onDelete();
          })}><Trash2 size={16} /></button>
        )}
      </header>
      {post.body && <p className="post-body"><RichText text={post.body} /></p>}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {post.imageUrl && <img className="post-image" src={post.imageUrl} alt="" loading="lazy" />}
      <footer className="post-actions">
        <button className={post.liked ? "liked" : ""} onClick={() => void like()} aria-pressed={post.liked}>
          <Heart size={18} fill={post.liked ? "currentColor" : "none"} /> {post.likeCount || ""}
        </button>
        <button onClick={() => void toggleComments()}><MessageCircle size={18} /> {post.commentCount || ""}</button>
      </footer>
      {open && (
        <div className="comments">
          {comments === null && <Spinner />}
          {comments?.map((c) => (
            <div key={c.id} className="comment">
              <Avatar name={c.author.displayName} hue={c.author.avatarHue} size={28} />
              <div><strong onClick={() => onOpenProfile(c.author.username)}>{c.author.displayName}</strong> <RichText text={c.body} /><small>{ago(c.createdAt)}</small></div>
            </div>
          ))}
          <form className="row gap-xs" onSubmit={(e) => {
            e.preventDefault();
            if (!reply.trim()) return;
            void run(async () => {
              const res = await api<{ comment: Comment }>(`/api/posts/${post.id}/comments`, { body: { body: reply.trim() } });
              setComments((x) => [...(x ?? []), res.comment]);
              onChange({ ...post, commentCount: post.commentCount + 1 });
              setReply("");
            });
          }}>
            <input className="input grow" value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Write a comment…" maxLength={1000} />
            <button className="btn btn-primary sm" disabled={busy || !reply.trim()}>Reply</button>
          </form>
        </div>
      )}
    </article>
  );
}
