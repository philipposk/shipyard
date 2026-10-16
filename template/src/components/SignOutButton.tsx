/** Sign-out is a form POST so nothing can sign you out by just loading a link. */
export function SignOutButton({ className = "btn btn-secondary", label = "Sign out" }: { className?: string; label?: string }) {
  return (
    <form action="/auth/sign-out" method="post">
      <button type="submit" className={className}>
        {label}
      </button>
    </form>
  );
}
