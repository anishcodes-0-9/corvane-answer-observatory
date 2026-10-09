import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "@fontsource-variable/inter-tight/index.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./globals.css";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import Nav from "./_components/Nav";

export const metadata: Metadata = {
  title: "Corvane — Answer Observatory",
  description: "How AI engines see, recommend and describe Corvane Fleet and its competitors.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#content">Skip to content</a>
        <header className="masthead">
          <Link className="mark" href="/">
            <b>Corvane</b>
            <span>Answer Observatory</span>
          </Link>
          <Nav />
        </header>
        <main id="content">{children}</main>
        <footer className="footer">
          <span>Rules-based analysis of AI answers. No paid APIs; every figure traces to an answer.</span>
          <span>Fictional client and data · case study</span>
        </footer>
      </body>
    </html>
  );
}
