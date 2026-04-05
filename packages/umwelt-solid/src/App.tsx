import type { Component } from 'solid-js';

import styles from './App.module.scss';
import { UmweltSpecProvider } from './contexts/UmweltSpecContext';
import { UmweltDatastoreProvider } from './contexts/UmweltDatastoreContext';
import { Umwelt } from './components';

const App: Component = () => {
  console.log('Rendering App component');
  return (
    <div class={styles.App}>
      <div style={{ color: 'red' }}>DEBUG: App is rendering</div>
      <UmweltDatastoreProvider>
        <UmweltSpecProvider>
          <Umwelt />
        </UmweltSpecProvider>
      </UmweltDatastoreProvider>
    </div>
  );
};

export default App;
