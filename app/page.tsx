import { ServiceWorkerRegistration } from "@/components/service-worker-registration";
import { TowerApp } from "@/components/tower-app";

export default function Home() {
  return (
    <>
      <TowerApp />
      <ServiceWorkerRegistration />
    </>
  );
}
