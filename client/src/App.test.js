import { render, screen } from '@testing-library/react';
import App from './App';

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
