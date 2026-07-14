import { InstallPrompt } from "@/components/install-prompt";
import { ServiceWorkerRegistration } from "@/components/service-worker-registration";
import { TowerApp } from "@/components/tower-app";

export default function Home() {
  return (
    <>
      <TowerApp />
      <InstallPrompt />
      <ServiceWorkerRegistration />
    </>
  );
}
