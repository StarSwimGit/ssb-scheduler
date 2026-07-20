"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { productImageUrl } from "@/lib/supabaseClient";
import { rm } from "@/lib/money";
import type { Product } from "@/lib/types";

export default function CatalogClient({ products }: { products: Product[] }) {
  const categories = useMemo(
    () => Array.from(new Set(products.map((p) => p.category))).sort(),
    [products]
  );
  const [cat, setCat] = useState<string>("All");
  const shown = cat === "All" ? products : products.filter((p) => p.category === cat);

  return (
    <div>
      {/* ==================== HERO ==================== */}
      <section className="relative mb-14 overflow-hidden rounded-[28px] shadow-hero"
        style={{ background: "linear-gradient(118deg, #061626 0%, #0a2c48 52%, #0f3f5f 100%)" }}
      >
        <div className="hero-lanes" />
        <div className="hero-diag" />
        <div className="hero-glow" />
        <div className="hero-sheen" />
        <div className="hero-bubble" style={{ left: "60%", width: 10, height: 10, animationDelay: ".6s" }} />
        <div className="hero-bubble" style={{ left: "70%", width: 6, height: 6, animationDelay: "2.2s", animationDuration: "5.5s" }} />

        <div className="relative grid items-center gap-4 md:grid-cols-[1.15fr,.85fr]">
          <div className="px-8 py-14 md:px-16 md:py-16">
            <div className="mb-6 flex items-center gap-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo.png" alt="Kurenang" className="h-8 w-auto brightness-0 invert drop-shadow" />
              <span className="h-6 w-px bg-white/20" />
              <span className="font-head text-[12px] font-black uppercase tracking-[.24em] text-cyan-soft">
                Equipment Store
              </span>
            </div>
            <h1
              className="display m-0 text-[64px] leading-[.85] md:text-[88px]"
              style={{ textShadow: "0 0 46px rgba(41,182,232,.3)" }}
            >
              Built for
              <br />
              the{" "}
              <span
                style={{
                  background: "linear-gradient(100deg, #5eead4, #29b6e8 55%, #3f79d6)",
                  WebkitBackgroundClip: "text",
                  backgroundClip: "text",
                  color: "transparent"
                }}
              >
                fast lane.
              </span>
            </h1>
            <p className="mt-6 max-w-lg text-lg leading-relaxed text-text-mute">
              Race-day kit and squad training packs, sorted. Order online, then catch your gear
              poolside at your next session — suited up before the whistle blows.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a href="#catalog" className="btn-primary">
                Browse catalog <span className="text-lg">→</span>
              </a>
              <Link href="/track" className="btn-ghost">Track order</Link>
            </div>
          </div>

          {/* Mascot slot — safe fallback if image missing */}
          <div className="relative hidden self-stretch md:block">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/mascot.png"
              alt=""
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
              className="absolute right-[-10%] top-1/2 max-h-[420px] w-auto -translate-y-1/2"
              style={{ filter: "drop-shadow(0 22px 44px rgba(0,0,0,.5))" }}
            />
          </div>
        </div>
      </section>

      {/* ==================== CATALOG HEADER ==================== */}
      <div
        id="catalog"
        className="mb-6 flex flex-wrap items-end justify-between gap-5"
      >
        <div>
          <p className="eyebrow mb-2">The catalog</p>
          <h2 className="display m-0 text-4xl md:text-5xl">Grab your gear</h2>
        </div>
        <p className="font-mono text-sm tracking-wide text-text-dim">
          {shown.length} item{shown.length === 1 ? "" : "s"} in stock
        </p>
      </div>

      {/* Category chips */}
      <div className="mb-8 flex flex-wrap gap-3">
        <button className={`chip ${cat === "All" ? "chip-active" : ""}`} onClick={() => setCat("All")}>All</button>
        {categories.map((c) => (
          <button key={c} className={`chip ${cat === c ? "chip-active" : ""}`} onClick={() => setCat(c)}>
            {c}
          </button>
        ))}
      </div>

      {/* Product grid */}
      <div className="grid grid-cols-2 gap-5 pb-6 md:grid-cols-3">
        {shown.map((p) => {
          const img = productImageUrl(p.image_path);
          return (
            <Link
              key={p.id}
              href={`/product/${p.id}`}
              className="card group overflow-hidden transition-all hover:-translate-y-1.5 hover:border-cyan-bright hover:shadow-card"
            >
              <div className="relative aspect-[4/3] bg-lane">
                {img ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={img}
                    alt={p.name}
                    className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
                  />
                ) : (
                  <span className="flex h-full w-full items-center justify-center text-5xl opacity-40">🏊</span>
                )}
                <span
                  className="absolute left-3 top-3 rounded-full border border-edgeStrong px-2.5 py-1 font-head text-[10.5px] font-extrabold uppercase tracking-widest text-cyan-soft backdrop-blur"
                  style={{ background: "rgba(5,15,26,.68)" }}
                >
                  {p.category}
                </span>
                {p.stock <= 0 && (
                  <span className="absolute right-3 top-3 rounded-full bg-red-500/85 px-2.5 py-1 font-head text-[10.5px] font-extrabold uppercase tracking-widest text-white">
                    Out
                  </span>
                )}
              </div>
              <div className="px-5 pb-5 pt-4">
                <h3 className="font-head text-[17px] font-extrabold leading-tight text-text-hi">{p.name}</h3>
                <div className="mt-3 flex items-center justify-between">
                  <span className="font-mono text-[17px] font-semibold text-cyan-bright">{rm(p.price_cents)}</span>
                  <span
                    className="rounded-lg px-3.5 py-2 font-head text-[12px] font-black uppercase tracking-wider transition-opacity"
                    style={{ background: "linear-gradient(100deg, #29b6e8, #38d6f0)", color: "#04202e" }}
                  >
                    View →
                  </span>
                </div>
              </div>
            </Link>
          );
        })}
      </div>
      {shown.length === 0 && (
        <p className="py-12 text-center text-text-dim">No products in this category yet.</p>
      )}
    </div>
  );
}
