import Link from 'next/link'

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl items-center px-6 py-16">
      <section
        aria-labelledby="page-title"
        className="w-full rounded-2xl bg-white p-8 shadow-sm"
      >
        <p className="font-semibold text-sky-800">Telegram Agent</p>
        <h1
          id="page-title"
          className="mt-2 text-3xl font-bold tracking-tight text-slate-950"
        >
          Operational dashboard
        </h1>
        <p className="mt-4 max-w-prose text-slate-700">
          Sign in to inspect conversations and service operation.
        </p>
        <Link
          className="mt-6 inline-flex min-h-11 items-center rounded-lg bg-sky-800 px-5 py-2 font-semibold text-white hover:bg-sky-900"
          href="/login"
        >
          Dashboard sign in
        </Link>
      </section>
    </main>
  )
}
