"use client";

import { ArrowDownLeft, ArrowUpRight, Gift, Lock, Plus, Receipt } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { ago, rupees } from "@/lib/client/selectors";
import { useAction, useEngine } from "./context";
import { Empty, Modal, Spinner } from "./ui";

type Wallet = {
  balance: number;
  testMode: boolean;
  entries: {
    id: number; transferId: string; amount: number; balanceAfter: number; createdAt: string; kind: string; conversationId: string | null;
    counterparty: { id: string; displayName: string; username: string } | null;
  }[];
  pendingRequests: { id: string; conversationId: string; amount: number; requesterName: string; createdAt: string }[];
};

export function WalletView({ onOpenChat }: { onOpenChat: (id: string) => void }) {
  const engine = useEngine();
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [topup, setTopup] = useState(false);
  const [run, busy] = useAction();

  const load = useCallback(() => api<Wallet>("/api/wallet").then(setWallet), []);
  // Reload whenever chat activity (payments) arrives.
  useEffect(() => {
    void load();
  }, [load, engine.version]);

  if (!wallet) return <div className="center pad"><Spinner /></div>;
  const month = new Date();
  month.setDate(1);
  const thisMonth = wallet.entries.filter((e) => new Date(e.createdAt) >= month);
  const spent = thisMonth.filter((e) => e.amount < 0).reduce((s, e) => s - e.amount, 0);
  const received = thisMonth.filter((e) => e.amount > 0 && e.kind === "transfer").reduce((s, e) => s + e.amount, 0);

  return (
    <div className="wallet">
      <header className="page-head">
        <div><h1>Wallet</h1><p className="muted">Pay and split bills right inside your chats.</p></div>
      </header>

      <div className="balance-card">
        <div className="balance-top">
          <span>Available balance</span>
          {wallet.testMode && <span className="test-chip">TEST MODE</span>}
        </div>
        <div className="balance-amount">{rupees(wallet.balance)}</div>
        <div className="balance-stats">
          <span><ArrowUpRight size={14} /> {rupees(spent)} spent this month</span>
          <span><ArrowDownLeft size={14} /> {rupees(received)} received</span>
        </div>
        <div className="row gap-xs">
          {wallet.testMode && <button className="btn btn-light" onClick={() => setTopup(true)}><Plus size={17} /> Add test money</button>}
        </div>
        <span className="balance-glyph" aria-hidden="true">₹</span>
      </div>

      <p className="muted small wallet-note"><Lock size={12} /> Payment notes are end-to-end encrypted. Amounts are recorded in a double-entry ledger on the server.
        {wallet.testMode && " This build uses simulated money — connect a licensed payment gateway (e.g. Razorpay/UPI) before handling real funds."}</p>

      {wallet.pendingRequests.length > 0 && (
        <section className="card-section">
          <h3><Receipt size={17} /> Waiting for you</h3>
          {wallet.pendingRequests.map((r) => (
            <div key={r.id} className="ledger-row">
              <span className="ledger-icon req">🧾</span>
              <span className="ledger-copy"><strong>{r.requesterName} requested</strong><small>{ago(r.createdAt)}</small></span>
              <span className="ledger-amt">{rupees(r.amount)}</span>
              <button className="btn btn-primary sm" disabled={busy} onClick={() => void run(async () => {
                await engine.resolveRequest(r.id, "pay");
                await load();
              }, "Paid ✓")}>Pay</button>
              <button className="link sm" onClick={() => onOpenChat(r.conversationId)}>Open chat</button>
            </div>
          ))}
        </section>
      )}

      <section className="card-section">
        <h3>Activity</h3>
        {wallet.entries.length === 0 && <Empty icon="💸" title="No transactions yet"><p>Open a chat, tap + and choose Pay.</p></Empty>}
        {wallet.entries.map((e) => (
          <button key={e.id} className="ledger-row" disabled={!e.conversationId} onClick={() => e.conversationId && onOpenChat(e.conversationId)}>
            <span className={`ledger-icon ${e.amount < 0 ? "out" : "in"}`}>
              {e.kind === "bonus" ? <Gift size={18} /> : e.amount < 0 ? <ArrowUpRight size={18} /> : <ArrowDownLeft size={18} />}
            </span>
            <span className="ledger-copy">
              <strong>{e.kind === "bonus" ? "Welcome bonus" : e.kind === "topup" ? "Test top-up" : e.amount < 0 ? `To ${e.counterparty?.displayName}` : `From ${e.counterparty?.displayName}`}</strong>
              <small>{new Date(e.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</small>
            </span>
            <span className={`ledger-amt ${e.amount > 0 ? "pos" : ""}`}>{rupees(e.amount, { sign: true })}</span>
          </button>
        ))}
      </section>

      {topup && <TopUp onClose={() => setTopup(false)} onDone={() => { setTopup(false); void load(); }} />}
    </div>
  );
}

function TopUp({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [run, busy] = useAction();
  const [amount, setAmount] = useState("1000");
  const paise = Math.round(Number(amount) * 100);
  return (
    <Modal title="Add test money" onClose={onClose} footer={
      <button className="btn btn-primary btn-block" disabled={busy || !(paise >= 100 && paise <= 1_000_000)} onClick={() => void run(async () => {
        await api("/api/wallet/topup", { body: { amount: paise } });
        onDone();
      }, "Added")}>Add {paise >= 100 ? rupees(paise) : ""}</button>
    }>
      <p className="muted">For testing only — up to ₹10,000 at a time. No real money is charged.</p>
      <div className="amount"><span>₹</span><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} /></div>
    </Modal>
  );
}
