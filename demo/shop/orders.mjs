function orderTotal(order) {
  return order.total.toFixed(2);
}

export function createOrder(order) {
  try {
    return { status: 201, body: { id: 1046, total: orderTotal(order) } };
  } catch (error) {
    return {
      status: 500,
      body: {
        error: 'Order service error',
        detail: `${error.message} (order for ${order?.customer?.email})`,
      },
    };
  }
}
