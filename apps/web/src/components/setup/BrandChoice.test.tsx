import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SetupWizard } from './SetupWizard';

const fetchMock = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation((path) =>
    Promise.resolve(
      path === '/api/setup/onvif/scan'
        ? new Response(JSON.stringify({ cameras: [] }), { status: 200 })
        : new Response(null, { status: 204 }),
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function toBrand(user: ReturnType<typeof userEvent.setup>) {
  render(<SetupWizard onDone={() => {}} />);
  await user.type(screen.getByLabelText('Password'), 'sleepy-owl-42');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByRole('heading', { name: 'Which camera do you have?' });
}

it("BrandChoice routes Kasa to today's choice and Another brand to OnvifSetup", async () => {
  const user = userEvent.setup();
  await toBrand(user);
  expect(screen.getByText('Reolink, Tapo, Amcrest and others')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Kasa' }));
  expect(await screen.findByRole('heading', { name: 'Your camera' })).toBeTruthy();
  cleanup();

  await toBrand(user);
  await user.click(screen.getByRole('button', { name: /Another brand/ }));
  expect(await screen.findByRole('heading', { name: 'Find your camera' })).toBeTruthy();
});
