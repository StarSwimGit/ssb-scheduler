import type { Metadata } from "next";
import "./globals.css";
import Header from "@/components/Header";
import Footer from "@/components/Footer";

export const metadata: Metadata = {
  title: "Kurenang Store — Built for the fast lane",
  description:
    "Race-day kit and squad training packs for Kurenang swimmers. Order online, collect poolside."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Anton&family=Archivo:wght@600;800;900&family=Barlow+Semi+Condensed:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="lane-bg">
        <Header />
        <main className="mx-auto w-full max-w-6xl px-5 pt-6 md:pt-10">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
