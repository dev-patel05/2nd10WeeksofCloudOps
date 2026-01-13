import { render, screen } from '@testing-library/react';
import App from './App';

// Mock axios to prevent actual network requests during tests
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    get: jest.fn(() => Promise.resolve({ data: [] })),
    post: jest.fn(() => Promise.resolve({ data: {} })),
    put: jest.fn(() => Promise.resolve({ data: {} })),
    delete: jest.fn(() => Promise.resolve({ data: {} })),
  },
}));

test('renders book shop heading', () => {
  render(<App />);
  const headingElement = screen.getByText(/Ankit book Shop/i);
  expect(headingElement).toBeInTheDocument();
});

test('renders add new book link', () => {
  render(<App />);
  const linkElement = screen.getByText(/Add new book/i);
  expect(linkElement).toBeInTheDocument();
});
