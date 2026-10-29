"use client";

import { MessageCircle, UserCheck, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { lastSeen } from "@/lib/client/selectors";
import type { PublicUser } from "@/lib/client/types";
import { useAction, useEngine } from "./context";
import { PostCard, type Post } from "./FeedView";
import { Avatar, Modal, Spinner } from "./ui";

type Profile = { user: PublicUser; stats: { followers: number; following: number; posts: number }; followed: boolean; isMe: boolean };

export function ProfileSheet({ username, onClose, onMessage }: { username: string; onClose: () => void; onMessage: (conversationId: string) => void }) {
  const engine = useEngine();
  const [run, busy] = useAction();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<Profile>(`/api/users/${encodeURIComponent(username)}`)
      .then((p) => {
        setProfile(p);
        return api<{ posts: Post[] }>(`/api/posts?scope=user&userId=${p.user.id}`);
      })
      .then((r) => setPosts(r.posts))
      .catch((e: Error) => setError(e.message));
  }, [username]);

  return (
    <Modal title="Profile" onClose={onClose} wide>
      {error && <p className="form-error">{error}</p>}
      {!profile && !error && <div className="center pad"><Spinner /></div>}
      {profile && (
        <>
          <div className="profile-hero">
            <Avatar name={profile.user.displayName} hue={profile.user.avatarHue} size={92} />
            <h3>{profile.user.displayName}</h3>
            <p className="muted">@{profile.user.username}{profile.user.lastSeenAt && !profile.isMe ? ` · ${lastSeen(profile.user.lastSeenAt)}` : ""}</p>
            {profile.user.bio && <p className="profile-bio">{profile.user.bio}</p>}
            <div className="stats">
              <span><b>{profile.stats.posts}</b> posts</span>
              <span><b>{profile.stats.followers}</b> followers</span>
              <span><b>{profile.stats.following}</b> following</span>
            </div>
            {!profile.isMe && (
              <div className="row gap-xs">
                <button className="btn btn-primary" disabled={busy} onClick={() => void run(async () => onMessage(await engine.openDirect(profile.user)))}>
                  <MessageCircle size={17} /> Message
                </button>
                <button className="btn btn-ghost" disabled={busy} onClick={() => void run(async () => {
                  const res = await api<{ followed: boolean }>("/api/follow", { body: { userId: profile.user.id, follow: !profile.followed } });
                  setProfile({ ...profile, followed: res.followed, stats: { ...profile.stats, followers: profile.stats.followers + (res.followed ? 1 : -1) } });
                })}>
                  {profile.followed ? <><UserCheck size={17} /> Following</> : <><UserPlus size={17} /> Follow</>}
                </button>
              </div>
            )}
          </div>
          <div className="posts">
            {posts === null && <Spinner />}
            {posts?.length === 0 && <p className="muted center">No posts yet.</p>}
            {posts?.map((p) => (
              <PostCard key={p.id} post={p} onOpenProfile={() => undefined}
                onChange={(next) => setPosts((x) => x!.map((y) => (y.id === p.id ? next : y)))}
                onDelete={() => setPosts((x) => x!.filter((y) => y.id !== p.id))} />
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
