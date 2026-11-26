import { useState } from 'react';
import { CameraChoice, type CameraKind } from './CameraChoice';
import { ExistingCamera } from './ExistingCamera';
import { Onboarding } from './Onboarding';
import { PasswordStep } from './PasswordStep';

type Step = 'password' | 'choice' | 'existing' | 'account' | 'local';

export function SetupWizard({ onDone }: { onDone(): void }) {
  const [step, setStep] = useState<Step>('password');

  if (step === 'password') return <PasswordStep onNext={() => setStep('choice')} />;
  if (step === 'existing') {
    return <ExistingCamera onDone={onDone} onBack={() => setStep('choice')} />;
  }
  if (step === 'account' || step === 'local') {
    return <Onboarding mode={step} onDone={onDone} onCancel={() => setStep('choice')} />;
  }
  return <CameraChoice onChoose={(kind: CameraKind) => setStep(kind)} />;
}
