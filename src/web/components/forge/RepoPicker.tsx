// Stub — replaced by the list-tabs work (#2179).
export default function RepoPicker({ value }: { value: string | null; allowAll: boolean; onChange: (repo: string | null) => void }) {
  return <span className="fg-repo">{value ?? "All projects"}</span>;
}
