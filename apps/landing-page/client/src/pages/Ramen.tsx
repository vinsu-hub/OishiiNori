import DishLandingPage from '@/components/DishLandingPage';
import type { ApiProduct } from '@/lib/api';

export default function Ramen({ initialData }: { initialData?: { products: ApiProduct[] } } = {}) {
  return <DishLandingPage route="/ramen" initialData={initialData} />;
}
