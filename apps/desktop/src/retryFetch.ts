/**
 * fetch, tried once more after 200 ms when the first attempt throws. The self-test's requests
 * to its own server sometimes see a dropped connection (ECONNRESET) on a busy CI machine.
 */
export async function retryFetch(url: string, fetchImpl: typeof fetch = fetch): Promise<Response> {
  try {
    return await fetchImpl(url);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return fetchImpl(url);
  }
}
