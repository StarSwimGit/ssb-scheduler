"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { cartCount } from "@/lib/cart";
import { supabase } from "@/lib/supabaseClient";

export default function Header() {
  const [count, setCount] = useState(0);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    const update = () => setCount(cartCount());
    update();
    window.addEventListener("cart-changed", update);
    window.addEventListener("storage", update);
    supabase.auth.getSession().then(({ data }) => setIsAdmin(!!data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => setIsAdmin(!!session));
    return () => {
      window.removeEventListener("cart-changed", update);
      window.removeEventListener("storage", update);
      sub.subscription.unsubscribe();
    };
  }, []);

  return (
    <header
      className="sticky top-0 z-40 border-b border-edge backdrop-blur-md"
      style={{ background: "rgba(5,15,26,.72)" }}
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-4">
        <Link href="/" className="flex items-center gap-3.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="Kurenang" className="block h-7 w-auto brightness-0 invert md:h-8" />
          <span className="h-5 w-px bg-white/20" />
          <span className="font-head text-[11px] font-black uppercase tracking-[.24em] text-cyan-soft">
            Store
          </span>
        </Link>
        <nav className="flex items-center gap-1.5 md:gap-2.5">
          <Link href="/" className="hidden rounded-lg px-3 py-2 font-head text-[13px] font-extrabold uppercase tracking-wider text-text-body hover:text-white sm:block">
            Shop
          </Link>
          <Link href="/track" className="rounded-lg px-3 py-2 font-head text-[13px] font-extrabold uppercase tracking-wider text-text-body hover:text-white">
            Track
          </Link>
          <Link href="/cart" className="btn-primary !px-4 !py-2.5 !text-[13px]">
            Cart
            <span className="inline-flex min-w-[20px] items-center justify-center rounded-full bg-deep px-1.5 font-mono text-[11px] text-cyan-soft">
              {count}
            </span>
          </Link>
          <Link
            href={isAdmin ? "/admin" : "/admin/login"}
            className="rounded-lg border border-edgeStrong px-3 py-2 font-head text-[11px] font-extrabold uppercase tracking-[.08em] text-text-dim hover:border-cyan-bright hover:text-cyan-soft"
            title={isAdmin ? "Admin dashboard" : "Admin login"}
          >
            {isAdmin ? "Admin" : "L"}
          </Link>
        </nav>
      </div>
    </header>
  );
}
