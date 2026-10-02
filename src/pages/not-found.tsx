import { pagePaths } from "@/lib/dashboard/routes"

export function NotFoundPage() {
  return <main className="rawroute-not-found">
    <a className="nf-brand" href={pagePaths.home} aria-label="RawRoute home">RawRoute<span aria-hidden="true">.</span></a>
    <section className="nf-content" aria-labelledby="not-found-title">
      <p className="nf-code" aria-hidden="true">404</p>
      <h1 id="not-found-title">Page not found</h1>
      <p className="nf-description">The page you’re looking for may have moved or is no longer available.</p>
      <nav className="nf-actions" aria-label="Page recovery">
        <a className="nf-link nf-primary" href={pagePaths.overview}>Go to overview <span aria-hidden="true">&nbsp;↗</span></a>
        <a className="nf-link" href={pagePaths.home}>Back to home</a>
      </nav>
    </section>
    <footer><span>One gateway. Every model.</span><span>Error 404</span></footer>
  </main>
}
