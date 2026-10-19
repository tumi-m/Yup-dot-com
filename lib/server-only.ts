/**
 * Stand-in for the "server-only" marker outside Next.js (the tests run
 * modules with tsx, which resolves "server-only" here through tsconfig.json
 * paths). In a Next.js build, importing "server-only" from code that reaches
 * a client component fails the build; see the modules that import it.
 */
export {};
