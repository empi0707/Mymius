/** Who is signed in: an initial in a circle (no remote images, the CSP forbids them), a name and an address. */
export function Account({ name, email }: { name: string | undefined; email: string | undefined }): React.JSX.Element {
  const label = name || email || 'Google account'
  return (
    <div className="account" data-testid="account">
      <span className="avatar" aria-hidden>{(label[0] ?? '?').toUpperCase()}</span>
      <span className="who">
        <strong data-testid="account-name">{label}</strong>
        {name && email && <span className="sub" data-testid="account-email">{email}</span>}
      </span>
    </div>
  )
}
