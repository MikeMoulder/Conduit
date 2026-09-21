import { ChainStatus } from "@/components/chain-status";
import { OwnerPanel } from "@/components/owner-panel";

export default function Home() {
  return (
    <div className="flex flex-col gap-10">
      <section className="flex flex-col gap-4">
        <h1 className="max-w-2xl text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
          An AI portfolio manager that cannot break its own risk limits.
        </h1>
        <p className="max-w-2xl text-base leading-relaxed text-zinc-400">
          The owner writes a mandate into a Solana account. The agent is granted
          exactly one power, to propose an allocation. Before anything moves, the
          program re-derives every constraint and refuses the transaction by
          name if one is breached.
        </p>
        <p className="max-w-2xl text-sm leading-relaxed text-zinc-500">
          The agent cannot widen its asset universe, cannot amend the mandate,
          cannot replace itself and cannot withdraw. Those are not promises a
          model makes. They are instructions it has no way to reach.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xs uppercase tracking-wide text-zinc-500">
          Deployment
        </h2>
        <ChainStatus />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xs uppercase tracking-wide text-zinc-500">
          Your accounts
        </h2>
        <OwnerPanel />
      </section>
    </div>
  );
}
