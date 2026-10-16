import DishLandingPage from '@/components/DishLandingPage';
import type { ApiProduct } from '@/lib/api';

export default function Sushi({ initialData }: { initialData?: { products: ApiProduct[] } } = {}) {
  return <DishLandingPage route="/sushi" initialData={initialData} />;
}
