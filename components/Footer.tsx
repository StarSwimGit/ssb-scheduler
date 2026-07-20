import Link from "next/link";

export default function Footer() {
  return (
    <footer className="relative mt-24 border-t border-edge" style={{ background: "rgba(5,13,22,.6)" }}>
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-5 px-6 py-10">
        <div className="flex items-center gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="Kurenang" className="h-7 w-auto brightness-0 invert" />
          <span className="max-w-sm text-sm leading-relaxed text-text-dim">
            Order online, collect poolside — race-ready the moment you hit the water.
          </span>
        </div>
        <div className="flex gap-6 font-head text-[12px] font-extrabold uppercase tracking-[.08em]">
          <Link href="/" className="text-cyan-bright hover:text-cyan-soft">Shop</Link>
          <Link href="/track" className="text-cyan-bright hover:text-cyan-soft">Track order</Link>
        </div>
      </div>
      <div className="border-t border-edge px-6 py-4 text-center font-mono text-[11px] tracking-widest text-text-faint">
        KURENANG SWIMMING CLUB · WAR BADGERS
      </div>
    </footer>
  );
}
