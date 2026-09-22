import { PortfolioView } from "@/components/portfolio-view";

export const metadata = {
  title: "Portfolio",
};

export default function PortfolioPage() {
  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Portfolio</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-zinc-400">
          What the mandate permits, what the portfolio holds, and what the agent
          wants to do about it. Every figure here was decoded from an account on
          chain rather than read from a database that could disagree with it.
        </p>
      </header>
      <PortfolioView />
    </div>
  );
}
