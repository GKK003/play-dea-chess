import './globals.css';

export const metadata = { title: 'Play Dea Chess', description: 'Chess training bot inspired by Dea Bedoshvili games' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
