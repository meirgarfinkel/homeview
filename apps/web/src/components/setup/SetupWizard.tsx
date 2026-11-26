import { useState } from 'react';
import { BrandChoice } from './BrandChoice';
import { CameraChoice, type CameraKind } from './CameraChoice';
import { ExistingCamera } from './ExistingCamera';
import { Onboarding } from './Onboarding';
import { OnvifSetup } from './OnvifSetup';
import { PasswordStep } from './PasswordStep';

type Step = 'password' | 'brand' | 'choice' | 'existing' | 'account' | 'local' | 'onvif';

export function SetupWizard({ onDone }: { onDone(): void }) {
  const [step, setStep] = useState<Step>('password');

  if (step === 'password') return <PasswordStep onNext={() => setStep('brand')} />;
  if (step === 'brand') {
    return <BrandChoice onChoose={(brand) => setStep(brand === 'kasa' ? 'choice' : 'onvif')} />;
  }
  if (step === 'onvif') return <OnvifSetup onDone={onDone} onBack={() => setStep('brand')} />;
  if (step === 'existing') {
    return <ExistingCamera onDone={onDone} onBack={() => setStep('choice')} />;
  }
  if (step === 'account' || step === 'local') {
    return <Onboarding mode={step} onDone={onDone} onCancel={() => setStep('choice')} />;
  }
  return (
    <CameraChoice onChoose={(kind: CameraKind) => setStep(kind)} onBack={() => setStep('brand')} />
  );
}
