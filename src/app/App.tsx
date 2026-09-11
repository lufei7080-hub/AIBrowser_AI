import { AppDialogProvider } from "../components/AppDialogProvider";
import { AppLayout } from "../components/AppLayout";
import { GlobalBannerProvider } from "../components/GlobalBannerProvider";
import { InterventionCenterPanel } from "../components/InterventionCenterPanel";
import { InterventionCenterProvider } from "../components/InterventionCenterProvider";

export default function App() {
  return (
    <AppDialogProvider>
      <GlobalBannerProvider>
        <InterventionCenterProvider>
          <AppLayout />
          <InterventionCenterPanel />
        </InterventionCenterProvider>
      </GlobalBannerProvider>
    </AppDialogProvider>
  );
}
