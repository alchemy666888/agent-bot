export default function Login() {
  return (
    <main id="content" className="shell">
      <h1>Dashboard login</h1>
      <form action="/login/submit" method="post">
        <label htmlFor="secret">Administrator secret</label>
        <input
          id="secret"
          name="secret"
          type="password"
          required
          autoComplete="current-password"
        />
        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}
