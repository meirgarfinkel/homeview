import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { NotPaired } from './NotPaired';

it('explains how to set the phone up', () => {
  render(<NotPaired />);
  expect(
    screen.getByText(
      "This phone isn't set up to watch from away. At home, scan the code in Kasa Home on your computer.",
    ),
  ).toBeTruthy();
});
