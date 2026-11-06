export function Logo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 30 30" fill="none">
      <path d="M4 11c5-4 10 4 15 0s7-3 7-3" stroke="#ece9e2" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M4 17c5-4 10 4 15 0s7-3 7-3" stroke="#93b4ff" strokeWidth="1.8" strokeLinecap="round" opacity=".85" />
      <path d="M4 23c5-4 10 4 15 0s7-3 7-3" stroke="#c4a6ff" strokeWidth="1.8" strokeLinecap="round" opacity=".6" />
    </svg>
  );
}
