import { useEffect, useState, type ReactNode } from 'react';
import type { CameraInfo, OnvifProfilesResult, SettingsResponse } from '@kasa/shared';
import { api } from '../lib/api';
import { errorText } from '../lib/errors';
import { BrandChoice } from './setup/BrandChoice';
import { CameraChoice, type CameraKind } from './setup/CameraChoice';
import { ExistingCamera } from './setup/ExistingCamera';
import { Onboarding } from './setup/Onboarding';
import { OnvifSetup, profileLabel } from './setup/OnvifSetup';

type Camera = NonNullable<SettingsResponse['camera']>;

function Panel({ children }: { children: ReactNode }) {
  return (
    <section className="panel">
      <h3>Camera in use</h3>
      {children}
    </section>
  );
}

/** Which camera HomeView watches, its stream, and a way to change it. This computer only. */
export function CameraSection({ camera, onChange }: { camera: Camera; onChange(): void }) {
  const [info, setInfo] = useState<CameraInfo>();
  useEffect(() => {
    api.camera().then(setInfo, () => undefined);
  }, []);
  const other = camera.kind === 'onvif';
  const label = info?.model
    ? other
      ? `${info.model}, other brand`
      : `Kasa ${info.model}`
    : other
      ? 'Other brand'
      : 'Kasa';
  return (
    <Panel>
      <p>{label}</p>
      <button className="btn" type="button" onClick={onChange}>
        Change camera
      </button>
    </Panel>
  );
}

/** A standard camera's stream profiles to choose from. */
export function StreamChoice() {
  const [list, setList] = useState<OnvifProfilesResult>();
  const [token, setToken] = useState<string>();
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.cameraProfiles().then(
      (r) => {
        setList(r);
        setToken(r.current ?? r.profiles[0]?.token);
      },
      (err: unknown) => setError(errorText(err)),
    );
  }, []);

  const choose = async (next: string) => {
    setToken(next);
    setSaved(false);
    setError(undefined);
    try {
      await api.setCameraProfile(next);
      setSaved(true);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <>
      {list && list.profiles.length > 1 && (
        <label className="field">
          <span>Stream</span>
          <select value={token} onChange={(e) => void choose(e.target.value)}>
            {list.profiles.map((p) => (
              <option key={p.token} value={p.token}>
                {profileLabel(p)}
              </option>
            ))}
          </select>
        </label>
      )}
      {saved && <p role="status">Stream saved.</p>}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

type Step = 'brand' | 'choice' | CameraKind | 'onvif';

/** Pick a new camera from settings. Nothing changes until the new one is saved. */
export function ChangeCamera({ onDone, onCancel }: { onDone(): void; onCancel(): void }) {
  const [step, setStep] = useState<Step>('brand');
  if (step === 'onvif') return <OnvifSetup onDone={onDone} onBack={() => setStep('brand')} />;
  if (step === 'existing') {
    return <ExistingCamera change onDone={onDone} onBack={() => setStep('choice')} />;
  }
  if (step === 'account' || step === 'local') {
    return <Onboarding mode={step} onDone={onDone} onCancel={() => setStep('choice')} />;
  }
  if (step === 'choice') {
    return <CameraChoice onChoose={setStep} onBack={() => setStep('brand')} />;
  }
  return (
    <BrandChoice
      onChoose={(brand) => setStep(brand === 'kasa' ? 'choice' : 'onvif')}
      onCancel={onCancel}
    />
  );
}
