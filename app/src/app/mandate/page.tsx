import { MandateForm } from "@/components/mandate-form";

export const metadata = {
  title: "Author a mandate",
};

export default function MandatePage() {
  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">
          Author a mandate
        </h1>
        <p className="max-w-2xl text-sm leading-relaxed text-zinc-400">
          A mandate is the constitution a portfolio runs under. You write it
          once, you sign it, and from then on the program checks every proposal
          against it. The agent can read it and cannot change it.
        </p>
      </header>
      <MandateForm />
    </div>
  );
}
