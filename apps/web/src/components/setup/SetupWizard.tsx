import { useState } from 'react';
import { CameraChoice, type CameraKind } from './CameraChoice';
import { ExistingCamera } from './ExistingCamera';
import { PasswordStep } from './PasswordStep';

type Step = 'password' | 'choice' | 'existing';

export function SetupWizard({
  onDone,
  onOnboarding,
}: {
  onDone(): void;
  /** Called for the two new-camera choices. Task 11 replaces this placeholder with its screens. */
  onOnboarding?(mode: 'account' | 'local'): void;
}) {
  const [step, setStep] = useState<Step>('password');

  if (step === 'password') return <PasswordStep onNext={() => setStep('choice')} />;
  if (step === 'existing') {
    return <ExistingCamera onDone={onDone} onBack={() => setStep('choice')} />;
  }
  const choose = (kind: CameraKind) => {
    if (kind === 'existing') setStep('existing');
    else onOnboarding?.(kind);
  };
  return <CameraChoice onChoose={choose} />;
}
