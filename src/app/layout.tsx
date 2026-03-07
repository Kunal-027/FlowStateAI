import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FlowState AI",
  description: "High-reliability, cloud-native autonomous testing engine",
};

/** Root layout: html (dark class), body, and global CSS. Sets app metadata (title, description). */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen font-sans">{children}</body>
    </html>
  );
}
